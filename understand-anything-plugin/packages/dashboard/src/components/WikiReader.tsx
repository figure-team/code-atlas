// ktds-fork (ADR-004): "문서"(wiki) 모드 전용 리더.
// 그래프 대신 메인 영역에 표시한다 — 상단 메타(태그·카테고리·백링크·연결)만 남기고
// 그 아래 노트 전체 본문(마크다운)을 렌더. 네비게이션은 Files 폴더 트리(사이드바).
import type { ReactNode } from "react";
import { useDashboardStore } from "../store";
import type { GraphNode } from "@understand-anything/core/types";
import ClaimsContent from "./ClaimsContent";

const MD_COMPONENTS = {
  h1: ({ children }: { children?: ReactNode }) => <h1 className="text-xl font-heading text-text-primary mt-4 mb-2">{children}</h1>,
  h2: ({ children }: { children?: ReactNode }) => <h2 className="text-base font-semibold text-text-primary mt-4 mb-1.5 border-b border-border-subtle pb-1">{children}</h2>,
  h3: ({ children }: { children?: ReactNode }) => <h3 className="text-sm font-semibold text-text-primary mt-3 mb-1">{children}</h3>,
  p: ({ children }: { children?: ReactNode }) => <p className="mb-2 leading-relaxed">{children}</p>,
  strong: ({ children }: { children?: ReactNode }) => <strong className="font-semibold text-text-primary">{children}</strong>,
  // 본문 링크는 비활성(이동은 상단 연결/백링크로) — 임의 외부 URL 클릭 차단
  a: ({ children }: { children?: ReactNode }) => <span className="text-accent">{children}</span>,
  blockquote: ({ children }: { children?: ReactNode }) => <blockquote className="border-l-2 border-accent/40 pl-3 my-2 text-text-muted italic">{children}</blockquote>,
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    const isBlock = className?.includes("language-");
    return isBlock ? (
      <code className="block bg-elevated rounded px-3 py-2 my-2 overflow-x-auto text-[12px] leading-relaxed">{children}</code>
    ) : (
      <code className="bg-elevated rounded px-1.5 py-0.5 text-[12px]">{children}</code>
    );
  },
  ul: ({ children }: { children?: ReactNode }) => <ul className="list-disc list-inside mb-2 space-y-1">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="list-decimal list-inside mb-2 space-y-1">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="leading-relaxed">{children}</li>,
};

function LinkChips({ title, nodes, onClick }: { title: string; nodes: GraphNode[]; onClick: (id: string) => void }) {
  if (nodes.length === 0) return null;
  return (
    <div className="flex items-start gap-2">
      <span className="text-[10px] uppercase tracking-wider text-text-muted shrink-0 pt-1">{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => onClick(n.id)}
            className="px-2 py-0.5 rounded bg-elevated text-[11px] text-text-secondary hover:text-accent hover:bg-accent/10 transition-colors"
          >
            {n.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function WikiReader() {
  const wikiGraph = useDashboardStore((s) => s.wikiGraph);
  const selectedNodeId = useDashboardStore((s) => s.selectedNodeId);
  const navigateToNode = useDashboardStore((s) => s.navigateToNode);
  const selectNode = useDashboardStore((s) => s.selectNode);

  const graph = wikiGraph;
  const node = graph?.nodes.find((n) => n.id === selectedNodeId) ?? null;

  if (!graph) return null;

  // 목차(인덱스): 계층(layers)별 article 노트 링크 — 선택 전 랜딩 + "목차" 버튼으로 복귀.
  if (!node) {
    return (
      <div className="h-full overflow-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <h1 className="font-heading text-2xl text-text-primary mb-1">문서</h1>
          <p className="text-[12px] text-text-muted mb-5">세분화 위키 — 계층에서 문서를 선택하거나, 문서 안의 연결/백링크로 이동하세요.</p>
          {graph.layers.map((layer) => {
            const articles = layer.nodeIds
              .map((id) => graph.nodes.find((n) => n.id === id))
              .filter((n): n is GraphNode => !!n && n.type === "article");
            if (articles.length === 0) return null;
            return (
              <div key={layer.id} className="mb-5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-2 border-b border-border-subtle pb-1">
                  {layer.name} <span className="text-text-muted/60">({articles.length})</span>
                </h2>
                <div className="flex flex-wrap gap-1.5">
                  {articles.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => navigateToNode(a.id)}
                      className="px-2.5 py-1 rounded bg-elevated text-[12px] text-text-secondary hover:text-accent hover:bg-accent/10 transition-colors"
                    >
                      {a.name}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 연결(나가는 위키링크) / 백링크(들어오는) / 카테고리(categorized_under)
  const connections = graph.edges
    .filter((e) => e.type === "related" && e.source === node.id)
    .map((e) => graph.nodes.find((n) => n.id === e.target))
    .filter((n): n is GraphNode => n !== undefined);
  const backlinks = graph.edges
    .filter((e) => e.type === "related" && e.target === node.id)
    .map((e) => graph.nodes.find((n) => n.id === e.source))
    .filter((n): n is GraphNode => n !== undefined);
  const categoryEdge = graph.edges.find((e) => e.type === "categorized_under" && e.source === node.id);
  const categoryNode = categoryEdge ? graph.nodes.find((n) => n.id === categoryEdge.target) ?? null : null;
  const content = node.knowledgeMeta?.content ?? "";

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-5">
        {/* 목차로 복귀 */}
        <button
          type="button"
          onClick={() => selectNode(null)}
          className="text-[11px] text-text-muted hover:text-accent transition-colors mb-2"
        >
          ← 목차
        </button>
        {/* 제목 */}
        <h1 className="font-heading text-2xl text-text-primary mb-3">{node.name}</h1>

        {/* 메타 스트립: 카테고리 · 태그 · 연결 · 백링크 (그 외 정보는 제외) */}
        <div className="space-y-2 pb-4 mb-4 border-b border-border-subtle">
          {categoryNode && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-text-muted shrink-0">카테고리</span>
              <button
                type="button"
                onClick={() => navigateToNode(categoryNode.id)}
                className="px-2 py-0.5 rounded bg-elevated text-[11px] text-accent hover:text-accent-bright transition-colors"
              >
                {categoryNode.name}
              </button>
            </div>
          )}
          {node.tags.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-[10px] uppercase tracking-wider text-text-muted shrink-0 pt-1">태그</span>
              <div className="flex flex-wrap gap-1.5">
                {node.tags.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 rounded bg-elevated text-[11px] text-text-secondary">#{tag}</span>
                ))}
              </div>
            </div>
          )}
          <LinkChips title="연결" nodes={connections} onClick={navigateToNode} />
          <LinkChips title="백링크" nodes={backlinks} onClick={navigateToNode} />
        </div>

        {/* 전체 본문 */}
        {content ? (
          <div className="text-sm text-text-secondary tour-markdown">
            <ClaimsContent content={content} mdComponents={MD_COMPONENTS} />
          </div>
        ) : (
          <p className="text-sm text-text-muted">_(본문 없음)_</p>
        )}
      </div>
    </div>
  );
}
