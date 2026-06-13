// ktds-fork (ADR-004): 노트/허브 본문 렌더 — `<!-- claims -->` 펜스 영역만 "근거 배지 카드"로
// 구조화 렌더하고, 나머지는 일반 마크다운. `<!-- wiki-links -->` 마커는 제거(내부 목록은 유지).
// 마커가 split/strip으로 소비되므로 react-markdown이 주석을 텍스트로 노출하던 문제도 함께 해결.
import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown from "react-markdown";

type MdComponents = ComponentProps<typeof ReactMarkdown>["components"];

// 신뢰도 태그 → 배지 색 (대시보드 팔레트 재사용).
function tagClass(tag: string): string {
  if (tag.startsWith("확정")) return "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";
  if (tag.startsWith("추정")) return "text-amber-400 border-amber-500/40 bg-amber-500/10";
  if (tag.startsWith("확인")) return "text-[#c97070] border-[#c97070]/40 bg-[#c97070]/10";
  return "text-text-muted border-border-medium bg-elevated";
}

interface ParsedClaim {
  tag: string;
  text: string;
  cite?: string;
}

// `- [태그] 본문 — 근거: \`path:line\`` 한 줄 파싱 (renderClaim 포맷).
function parseClaims(block: string): ParsedClaim[] {
  const out: ParsedClaim[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const m = line.match(/^- \[([^\]]+)\]\s*(.*?)(?:\s*—\s*근거:\s*`([^`]+)`)?$/);
    if (m) out.push({ tag: m[1], text: m[2], cite: m[3] });
  }
  return out;
}

function ClaimsCard({ claims }: { claims: ParsedClaim[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="my-3 rounded-lg border border-border-subtle bg-elevated/40 p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-2">🔎 근거 ({claims.length})</div>
      <div className="space-y-2">
        {claims.map((c, i) => (
          <div key={i}>
            <div className="flex items-start gap-2">
              <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium ${tagClass(c.tag)}`}>
                {c.tag}
              </span>
              <span className="text-[12px] text-text-secondary leading-relaxed">{c.text}</span>
            </div>
            {c.cite && (
              <div className="ml-[2.1rem] mt-1 inline-block font-mono text-[10px] text-text-muted bg-base rounded px-1.5 py-0.5">
                📄 {c.cite}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type Segment = { type: "md"; text: string } | { type: "claims"; text: string };

// content → claims 펜스 기준 세그먼트. "세분화 항목"(wiki-links 펜스) 블록은 화면에서
// 통째로 제외(마커 + 내부 "## 세분화 항목" 목록 전부 제거).
function segmentize(content: string): Segment[] {
  const cleaned = content.replace(
    /<!--[ \t]*wiki-links[ \t]*-->[\s\S]*?<!--[ \t]*\/wiki-links[ \t]*-->[ \t]*\n?/g,
    "",
  );
  const fence = /<!--[ \t]*claims[ \t]*-->\n?([\s\S]*?)\n?<!--[ \t]*\/claims[ \t]*-->/g;
  const segs: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(cleaned)) !== null) {
    if (m.index > last) segs.push({ type: "md", text: cleaned.slice(last, m.index) });
    segs.push({ type: "claims", text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < cleaned.length) segs.push({ type: "md", text: cleaned.slice(last) });
  return segs;
}

// 옵시디언 위키링크 `[[target|label]]`/`[[target]]` → 읽기용 라벨 텍스트(비클릭).
// 대괄호 노출 방지만 하고 링크로는 만들지 않는다.
function wikilinksToText(text: string): string {
  return text.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_full, target, label) =>
    String(label ?? target).trim(),
  );
}

export default function ClaimsContent({
  content,
  mdComponents,
}: {
  content: string;
  mdComponents: MdComponents;
}): ReactNode {
  const segments = segmentize(content);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "claims" ? (
          <ClaimsCard key={i} claims={parseClaims(seg.text)} />
        ) : seg.text.trim() ? (
          <ReactMarkdown key={i} components={mdComponents}>
            {wikilinksToText(seg.text)}
          </ReactMarkdown>
        ) : null,
      )}
    </>
  );
}
