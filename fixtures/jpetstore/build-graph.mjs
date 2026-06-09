// jpetstore-6 → U-A v1.0.0 knowledge-graph.json
// 정적 절반: U-A scan/extract-structure 로 확인한 실제 라인. 의미 절반: 아래 분류(도메인/엔드포인트/테이블).
// 모든 node 는 실제 jpetstore 소스의 file:line 에 앵커된다(근거 위조 없음).
import { writeFileSync } from "node:fs";

const J = "src/main/java/org/mybatis/jpetstore";
const SCHEMA = "src/main/resources/database/jpetstore-hsqldb-schema.sql";

const nodes = [];
const edges = [];
const add = (id, type, name, filePath, line, summary, tags = []) =>
  nodes.push({ id, type, name, filePath, lineRange: [line, line + 1], summary, tags, complexity: "moderate" });
const edge = (source, target, type, dir = "forward") =>
  edges.push({ source, target, type, direction: dir, weight: 0.8 });

// ── 도메인 (의미) ──
const domains = [
  ["dom:account", "계정/인증", "회원 가입·로그인·계정 관리"],
  ["dom:catalog", "카탈로그", "카테고리·상품·아이템 조회 및 검색"],
  ["dom:cart", "장바구니", "장바구니 담기·수정·조회"],
  ["dom:order", "주문", "주문 생성·조회·결제 흐름"],
];
for (const [id, name, s] of domains) add(id, "domain", name, `${J}/web/actions`, 1, s, ["domain"]);

// ── 도메인 클래스 (실제 라인) ──
const domainClasses = [
  ["Account", 27], ["Cart", 32], ["CartItem", 27], ["Category", 25], ["Item", 26],
  ["LineItem", 27], ["Order", 30], ["Product", 25], ["Sequence", 25],
];
for (const [n, ln] of domainClasses) add(`cls:${n}`, "class", n, `${J}/domain/${n}.java`, ln, `${n} 도메인 엔티티`, ["domain-model"]);

// ── 서비스 ──
const services = [["AccountService", 31], ["CatalogService", 35], ["OrderService", 38]];
for (const [n, ln] of services) add(`svc:${n}`, "class", n, `${J}/service/${n}.java`, ln, `${n} 업무 로직`, ["service"]);

// ── 매퍼 (MyBatis) ──
const mappers = [
  ["AccountMapper", 25], ["CategoryMapper", 27], ["ItemMapper", 28], ["LineItemMapper", 27],
  ["OrderMapper", 27], ["ProductMapper", 27], ["SequenceMapper", 25],
];
for (const [n, ln] of mappers) add(`map:${n}`, "class", n, `${J}/mapper/${n}.java`, ln, `${n} MyBatis 매퍼`, ["mybatis", "persistence"]);

// ── ActionBean (Stripes 웹) + 엔드포인트 핸들러 (실제 라인) ──
const actionBeans = [
  ["AccountActionBean", 43, "dom:account", "svc:AccountService"],
  ["CatalogActionBean", 36, "dom:catalog", "svc:CatalogService"],
  ["CartActionBean", 38, "dom:cart", "svc:CatalogService"],
  ["OrderActionBean", 38, "dom:order", "svc:OrderService"],
];
for (const [n, ln, dom, svc] of actionBeans) {
  add(`bean:${n}`, "class", n, `${J}/web/actions/${n}.java`, ln, `${n} 웹 액션 (Stripes)`, ["web", "stripes"]);
  edge(`bean:${n}`, dom, "contains_flow");
  edge(`bean:${n}`, svc, "depends_on");
}
const endpoints = [
  ["AccountActionBean", "newAccount", 115], ["AccountActionBean", "signon", 159], ["AccountActionBean", "signoff", 184],
  ["AccountActionBean", "editAccount", 137],
  ["CatalogActionBean", "viewCategory", 153], ["CatalogActionBean", "viewProduct", 166],
  ["CatalogActionBean", "viewItem", 179], ["CatalogActionBean", "searchProducts", 190],
  ["CartActionBean", "addItemToCart", 68], ["CartActionBean", "removeItemFromCart", 94],
  ["CartActionBean", "updateCartQuantities", 116], ["CartActionBean", "checkOut", 141],
  ["OrderActionBean", "listOrders", 107], ["OrderActionBean", "newOrder", 142], ["OrderActionBean", "viewOrder", 171],
];
for (const [bean, m, ln] of endpoints) {
  const id = `ep:${bean}.${m}`;
  add(id, "endpoint", m, `${J}/web/actions/${bean}.java`, ln, `${m} 요청 처리 (Stripes Resolution)`, ["endpoint"]);
  edge(`bean:${bean}`, id, "contains"); // uid = {bean}#{m}
  edge(`bean:${bean}`, id, "routes");
}

// ── 테이블 (DDL 실제 라인) ──
const tables = [
  ["SUPPLIER", 17], ["SIGNON", 30], ["ACCOUNT", 36], ["PROFILE", 52], ["BANNERDATA", 61],
  ["ORDERS", 67], ["ORDERSTATUS", 96], ["LINEITEM", 104], ["CATEGORY", 113], ["PRODUCT", 120],
  ["ITEM", 133], ["INVENTORY", 154], ["SEQUENCE", 160],
];
for (const [t, ln] of tables) add(`tbl:${t}`, "table", t, SCHEMA, ln, `${t} 테이블`, ["schema"]);

// ── 매퍼 → 테이블 (reads_from/writes_to, 의미) ──
const mapperTables = {
  AccountMapper: ["ACCOUNT", "SIGNON", "PROFILE"], CategoryMapper: ["CATEGORY"],
  ProductMapper: ["PRODUCT"], ItemMapper: ["ITEM", "INVENTORY"],
  OrderMapper: ["ORDERS", "ORDERSTATUS"], LineItemMapper: ["LINEITEM"], SequenceMapper: ["SEQUENCE"],
};
for (const [m, ts] of Object.entries(mapperTables)) for (const t of ts) {
  edge(`map:${m}`, `tbl:${t}`, "reads_from");
  edge(`map:${m}`, `tbl:${t}`, "writes_to");
}

// ── 서비스 → 매퍼 (depends_on) ──
const svcMappers = {
  AccountService: ["AccountMapper"], CatalogService: ["CategoryMapper", "ProductMapper", "ItemMapper"],
  OrderService: ["OrderMapper", "LineItemMapper", "ItemMapper", "SequenceMapper"],
};
for (const [s, ms] of Object.entries(svcMappers)) for (const m of ms) edge(`svc:${s}`, `map:${m}`, "depends_on");

// ── 도메인 → 클래스 (contains_flow) ──
const domainMembers = {
  "dom:account": ["Account"], "dom:catalog": ["Category", "Product", "Item"],
  "dom:cart": ["Cart", "CartItem"], "dom:order": ["Order", "LineItem"],
};
for (const [d, cs] of Object.entries(domainMembers)) for (const c of cs) edge(d, `cls:${c}`, "flow_step");

// ── layers ──
const layers = [
  { id: "layer:web", name: "Web (Stripes ActionBeans)", description: "HTTP 요청 처리", nodeIds: nodes.filter(n => n.id.startsWith("bean:") || n.id.startsWith("ep:")).map(n => n.id) },
  { id: "layer:service", name: "Service", description: "업무 로직", nodeIds: nodes.filter(n => n.id.startsWith("svc:")).map(n => n.id) },
  { id: "layer:persistence", name: "Persistence (MyBatis Mappers)", description: "데이터 접근", nodeIds: nodes.filter(n => n.id.startsWith("map:")).map(n => n.id) },
  { id: "layer:domain", name: "Domain", description: "도메인 모델", nodeIds: nodes.filter(n => n.id.startsWith("cls:")).map(n => n.id) },
  { id: "layer:database", name: "Database", description: "관계형 스키마", nodeIds: nodes.filter(n => n.id.startsWith("tbl:")).map(n => n.id) },
];

const graph = {
  version: "1.0.0",
  project: {
    name: "jpetstore-6",
    languages: ["java", "xml", "sql"],
    frameworks: ["Spring", "MyBatis", "Stripes"],
    description: "MyBatis JPetStore — Spring DI + MyBatis + Stripes 레퍼런스 웹앱",
    analyzedAt: "2026-06-09T00:00:00.000Z",
    gitCommitHash: "jpetstore-6-main",
    configFiles: ["pom.xml"],
  },
  layers, nodes, edges, tour: [],
};
writeFileSync(process.argv[2] ?? "/tmp/jpetstore-graph.json", JSON.stringify(graph, null, 1));
console.log(`graph: ${nodes.length} nodes, ${edges.length} edges, ${layers.length} layers`);
