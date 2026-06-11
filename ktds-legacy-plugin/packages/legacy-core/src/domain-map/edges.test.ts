import { expect, test } from "vitest";
import { scanJavaFile, type JavaFileFacts } from "./java-facts.js";
import {
  buildClassIndex,
  buildMapperNamespaceIndex,
  collectEdges,
  resolveTypeRef,
} from "./edges.js";
import type { FileEdge } from "./types.js";

// 15.1 간선 수집 + 15.2 해소 레이어 단위 테스트. 디스크 픽스처 없이 인라인
// 소스로 facts를 만들어 순수 로직만 검증한다 (IO는 extract.ts 경계).

async function factsOf(
  files: Record<string, string>,
): Promise<Map<string, JavaFileFacts>> {
  const map = new Map<string, JavaFileFacts>();
  for (const [relPath, source] of Object.entries(files)) {
    map.set(relPath, await scanJavaFile(source));
  }
  return map;
}

async function edgesOf(
  files: Record<string, string>,
  xml: Record<string, string> = {},
): Promise<ReturnType<typeof collectEdges>> {
  const facts = await factsOf(files);
  return collectEdges(
    facts,
    buildClassIndex(facts),
    buildMapperNamespaceIndex(new Map(Object.entries(xml))),
  );
}

function find(edges: FileEdge[], kind: string): FileEdge[] {
  return edges.filter((e) => e.kind === kind);
}

test("import 간선: 프로젝트 클래스만, 외부(JDK/라이브러리)는 무대상", async () => {
  const { edges, unresolved } = await edgesOf({
    "src/a/Service.java": `package a;
import b.Repo;
import java.util.List;
public class Service {}`,
    "src/b/Repo.java": `package b;
public class Repo {}`,
  });
  expect(find(edges, "import")).toEqual([
    { source: "src/a/Service.java", target: "src/b/Repo.java", kind: "import", line: 2 },
  ]);
  expect(unresolved).toEqual([]);
});

test("필드 타입 간선: @Autowired→injection, 일반 필드→field-type, static 필드 제외", async () => {
  const { edges } = await edgesOf({
    "src/a/Controller.java": `package a;
import org.springframework.beans.factory.annotation.Autowired;
public class Controller {
  @Autowired
  private Service wired;
  private transient Service plain;
  private static Service ignored;
}`,
    "src/a/Service.java": `package a;
public class Service {}`,
  });
  expect(find(edges, "injection")).toHaveLength(1);
  expect(find(edges, "field-type")).toHaveLength(1);
  // static 필드는 어떤 kind로도 간선이 없다
  expect(edges.filter((e) => e.line === 7)).toEqual([]);
});

test("생성자 주입: ctor-param 간선", async () => {
  const { edges } = await edgesOf({
    "src/a/Service.java": `package a;
public class Service {
  private final Repo repo;
  public Service(Repo repo) { this.repo = repo; }
}`,
    "src/a/Repo.java": `package a;
public class Repo {}`,
  });
  expect(find(edges, "ctor-param")).toEqual([
    { source: "src/a/Service.java", target: "src/a/Repo.java", kind: "ctor-param", line: 4 },
  ]);
});

test("extends/implements + 역방향 impl 간선", async () => {
  const { edges } = await edgesOf({
    "src/a/Base.java": `package a;
public abstract class Base {}`,
    "src/a/Api.java": `package a;
public interface Api {}`,
    "src/a/Concrete.java": `package a;
public class Concrete extends Base implements Api {}`,
  });
  expect(find(edges, "extends")).toEqual([
    { source: "src/a/Concrete.java", target: "src/a/Base.java", kind: "extends", line: 2 },
  ]);
  expect(find(edges, "implements")).toEqual([
    { source: "src/a/Concrete.java", target: "src/a/Api.java", kind: "implements", line: 2 },
  ]);
  // 인터페이스 타입 참조를 구현으로 건널 수 있도록 역방향 간선이 생긴다
  expect(find(edges, "impl")).toEqual([
    { source: "src/a/Api.java", target: "src/a/Concrete.java", kind: "impl", line: null },
  ]);
});

test("이름규약 impl: 명시적 implements 없이 *Impl 클래스로 연결, 동일패키지 우선", async () => {
  const { edges } = await edgesOf({
    "src/a/UserService.java": `package a;
public interface UserService {}`,
    "src/a/UserServiceImpl.java": `package a;
public class UserServiceImpl {}`,
    "src/other/UserServiceImpl.java": `package other;
public class UserServiceImpl {}`,
  });
  expect(find(edges, "impl")).toEqual([
    {
      source: "src/a/UserService.java",
      target: "src/a/UserServiceImpl.java",
      kind: "impl",
      line: null,
    },
  ]);
});

test("해소 우선순위: 명시 import > 동일패키지 > 와일드카드 > 전역 유일", async () => {
  const facts = await factsOf({
    "src/a/User.java": `package a;
public class User {}`,
    "src/b/User.java": `package b;
public class User {}`,
    "src/c/OnlyOne.java": `package c;
public class OnlyOne {}`,
    "src/x/ViaImport.java": `package x;
import b.User;
public class ViaImport { private User u; }`,
    "src/a/SamePkg.java": `package a;
public class SamePkg { private User u; }`,
    "src/x/ViaWildcard.java": `package x;
import a.*;
public class ViaWildcard { private User u; }`,
    "src/x/Unique.java": `package x;
public class Unique { private OnlyOne o; }`,
    "src/x/Ambiguous.java": `package x;
public class Ambiguous { private User u; }`,
  });
  const index = buildClassIndex(facts);
  const resolve = (from: string): unknown =>
    resolveTypeRef("User", facts.get(from)!, index);

  expect(resolve("src/x/ViaImport.java")).toEqual({
    kind: "resolved",
    relPath: "src/b/User.java",
  });
  expect(resolve("src/a/SamePkg.java")).toEqual({
    kind: "resolved",
    relPath: "src/a/User.java",
  });
  expect(resolve("src/x/ViaWildcard.java")).toEqual({
    kind: "resolved",
    relPath: "src/a/User.java",
  });
  expect(resolveTypeRef("OnlyOne", facts.get("src/x/Unique.java")!, index)).toEqual({
    kind: "resolved",
    relPath: "src/c/OnlyOne.java",
  });
  expect(resolve("src/x/Ambiguous.java")).toEqual({ kind: "ambiguous" });
});

test("모호/미발견 참조는 unresolved로 보고된다 — 조용한 누락 금지", async () => {
  const { unresolved } = await edgesOf({
    "src/a/User.java": `package a;
public class User {}`,
    "src/b/User.java": `package b;
public class User {}`,
    "src/x/UsesAmbiguous.java": `package x;
public class UsesAmbiguous { private User u; }`,
    "src/a/UsesMissing.java": `package a;
import a.sub.Ghost;
public class UsesMissing { private Ghost g; }`,
  });
  expect(unresolved).toContainEqual({
    source: "src/x/UsesAmbiguous.java",
    ref: "User",
    reason: "ambiguous",
  });
  // 프로젝트 패키지 모양인데 census에 없는 import → not-found
  expect(unresolved).toContainEqual({
    source: "src/a/UsesMissing.java",
    ref: "a.sub.Ghost",
    reason: "not-found",
  });
});

test("MyBatis: 타입드 매퍼(FQN==namespace)와 SqlSession 문자열 호출", async () => {
  const mapperXml = `<?xml version="1.0"?>
<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x.dtd">
<mapper namespace="a.mapper.AccountMapper">
  <select id="getAccount">SELECT 1</select>
</mapper>`;
  const { edges } = await edgesOf(
    {
      "src/a/mapper/AccountMapper.java": `package a.mapper;
public interface AccountMapper {
  Object getAccount(String id);
}`,
      "src/a/dao/AccountDao.java": `package a.dao;
public class AccountDao {
  public Object get(String id) {
    return sqlSession.selectOne("a.mapper.AccountMapper.getAccount", id);
  }
  private Object sqlSession;
}`,
    },
    { "src/resources/a/mapper/AccountMapper.xml": mapperXml },
  );
  expect(find(edges, "mapper-xml")).toEqual([
    {
      source: "src/a/mapper/AccountMapper.java",
      target: "src/resources/a/mapper/AccountMapper.xml",
      kind: "mapper-xml",
      line: 2,
    },
  ]);
  expect(find(edges, "mybatis")).toEqual([
    {
      source: "src/a/dao/AccountDao.java",
      target: "src/resources/a/mapper/AccountMapper.xml",
      kind: "mybatis",
      line: 4,
    },
  ]);
});

test("주석 처리된 <mapper>는 namespace를 차지하지 못한다", () => {
  const index = buildMapperNamespaceIndex(
    new Map([
      [
        "a.xml",
        `<!-- <mapper namespace="dead.Ns"> --><mapper namespace="live.Ns"></mapper>`,
      ],
    ]),
  );
  expect(index.get("live.Ns")).toBe("a.xml");
  expect(index.has("dead.Ns")).toBe(false);
});

test("enum도 간선 타깃이 된다 (도메인 enum)", async () => {
  const { edges } = await edgesOf({
    "src/a/Status.java": `package a;
public enum Status { OPEN, CLOSED }`,
    "src/a/Order.java": `package a;
public class Order { private Status status; }`,
  });
  expect(find(edges, "field-type")).toEqual([
    { source: "src/a/Order.java", target: "src/a/Status.java", kind: "field-type", line: 2 },
  ]);
});

test("결정론: (source,target,kind) 중복 제거 — 최소 라인 보존, 자기참조 제외", async () => {
  const { edges } = await edgesOf({
    "src/a/Multi.java": `package a;
import a.Dep;
public class Multi extends Self {
  private Dep first;
  private Dep second;
}
class Self {}`,
    "src/a/Dep.java": `package a;
public class Dep {}`,
  });
  const fieldEdges = find(edges, "field-type");
  expect(fieldEdges).toEqual([
    { source: "src/a/Multi.java", target: "src/a/Dep.java", kind: "field-type", line: 4 },
  ]);
  // Self는 같은 파일 → 간선 없음
  expect(find(edges, "extends")).toEqual([]);
  // 전체가 (source, target, kind) 사전순
  const keys = edges.map((e) => `${e.source} ${e.target} ${e.kind}`);
  expect(keys).toEqual([...keys].sort());
});

test("컬렉션 필드의 제네릭 원소 타입도 간선이 된다 (List<Order> → Order)", async () => {
  const { edges } = await edgesOf({
    "src/a/Order.java": `package a;
import java.util.List;
import java.util.Map;
public class Order {
  private List<LineItem> lineItems;
  private Map<String, java.util.List<Tag>> tags;
}`,
    "src/a/LineItem.java": `package a;
public class LineItem {}`,
    "src/a/Tag.java": `package a;
public class Tag {}`,
  });
  const targets = find(edges, "field-type").map((e) => e.target);
  expect(targets).toContain("src/a/LineItem.java");
  expect(targets).toContain("src/a/Tag.java");
  // List/Map/String은 외부 → 간선 없음, unresolved에도 없음
  expect(targets).toHaveLength(2);
});

test("varargs 생성자 파라미터도 ctor-param 간선이 된다 (리뷰 반영)", async () => {
  const { edges } = await edgesOf({
    "src/a/Service.java": `package a;
public class Service {
  public Service(Handler... handlers) {}
}`,
    "src/a/Handler.java": `package a;
public class Handler {}`,
  });
  expect(find(edges, "ctor-param")).toEqual([
    { source: "src/a/Service.java", target: "src/a/Handler.java", kind: "ctor-param", line: 3 },
  ]);
});

test("중첩 클래스 동명이인: bare name은 top-level로 해소, FQN 충돌 없음 (리뷰 반영)", async () => {
  const facts = await factsOf({
    "src/a/Outer.java": `package a;
public class Outer {
  static class Helper {}
}`,
    "src/a/Helper.java": `package a;
public class Helper {}`,
    "src/a/Uses.java": `package a;
public class Uses { private Helper h; }`,
  });
  const index = buildClassIndex(facts);
  // 중첩 타입은 외부 체인 포함 FQN으로 등재된다
  expect(index.byFqn.get("a.Outer.Helper")?.relPath).toBe("src/a/Outer.java");
  expect(index.byFqn.get("a.Helper")?.relPath).toBe("src/a/Helper.java");
  // bare name 참조는 모호가 아니라 top-level로 해소 (javac 의미론)
  expect(resolveTypeRef("Helper", facts.get("src/a/Uses.java")!, index)).toEqual({
    kind: "resolved",
    relPath: "src/a/Helper.java",
  });
});

test("extends/implements 근거 라인은 절(clause) 위치를 가리킨다 (리뷰 반영)", async () => {
  const { edges } = await edgesOf({
    "src/a/Base.java": `package a;
public class Base {}`,
    "src/a/Api.java": `package a;
public interface Api {}`,
    "src/a/Sub.java": `package a;
public class Sub
    extends Base
    implements Api {}`,
  });
  expect(find(edges, "extends")[0].line).toBe(3);
  expect(find(edges, "implements")[0].line).toBe(4);
});

test("static import는 호스트 클래스로 연결된다", async () => {
  const { edges } = await edgesOf({
    "src/a/Constants.java": `package a;
public class Constants { public static final String X = "x"; }`,
    "src/b/Uses.java": `package b;
import static a.Constants.X;
public class Uses {}`,
  });
  expect(find(edges, "import")).toEqual([
    { source: "src/b/Uses.java", target: "src/a/Constants.java", kind: "import", line: 2 },
  ]);
});
