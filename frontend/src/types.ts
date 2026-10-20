/* Tipos do contrato REST do minirag (v2). Um lugar só para todo o front. */

export type Gaveta = {
  tenant: string;
  memoria: string;
  chunks: number;
  docs: number;
  chunks_arquivados: number;
  primeiro_ingress: string | null;
  ultimo_ingress: string | null;
};
export type GavetasResp = {
  operador: boolean;
  usuarios: string[];
  gavetas: Gaveta[];
  documentos_fonte: number;
};

export type DocItem = {
  doc_id: string;
  title: string;
  chunks: number;
  updated_at: string | null;
  chunks_arquivados: number;
};
export type DocsResp = { tenant: string; memoria: string; total: number; docs: DocItem[] };

export type Hit = {
  rank: number;
  score: number;
  chunk_id: number;
  doc_id: string;
  title: string;
  text: string;
  arquivado: boolean;
};
export type SearchResp = { tenant: string; memoria: string; items: Hit[]; total: number };

export type Job = {
  job_id: number;
  tenant: string;
  memoria: string;
  doc_id: string;
  title: string;
  status: string;
  chunks_total: number;
  chunks_feitos: number;
  erro: string | null;
  criado_em: string | null;
  finalizado_em: string | null;
};
export type JobsResp = { resumo_por_status: Record<string, number>; jobs: Job[] };

export type DocCompleto = {
  tenant: string;
  memoria: string;
  doc_id: string;
  title: string | null;
  content: string;
  size_bytes: number;
  origem: string;
  criado_em: string | null;
  atualizado_em: string | null;
};

export type JobStatus = {
  job_id: number;
  status: string;
  chunks_feitos: number;
  chunks_total: number;
  erro: string | null;
};
export type DecayResp = {
  arquivados_agora: number;
  docs_arquivados_agora: number;
  ativos: number;
  arquivados: number;
};
export type HealthResp = { status?: string; versao?: string; operador?: boolean; embedder?: string };

export type Escopo = { tenant: string; memoria: string };
export type Vista = "gavetas" | "arquivos" | "editor" | "buscar" | "jobs";