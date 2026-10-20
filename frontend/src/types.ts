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
  /** arquivo original guardado (pdf/docx/...); null quando o doc nasceu como texto */
  arquivo: {
    nome: string;
    tipo: string;
    ext?: string;
    editavel?: boolean;
    /** texto veio de OCR (imagem ou PDF escaneado) — confira no original */
    ocr?: boolean;
    tamanho: number;
  } | null;
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
/** telas de TOPO do menu lateral; "arquivos" e "editor" são passos do caminho */
export type Vista =
  | "painel"
  | "gavetas"
  | "chat"
  | "buscar"
  | "jobs"
  | "config"
  | "arquivos"
  | "editor";

export type DashboardResp = {
  versao: string;
  escopo: string;
  numeros: {
    usuarios: number;
    operadores: number;
    gavetas: number;
    documentos: number;
    chunks: number;
    chunks_arquivados: number;
    buscas_hoje: number;
    chats_hoje: number;
  };
  fila: Record<string, number>;
  buscas_hoje: number;
  chats_hoje: number;
  por_usuario: { tenant: string; documentos: number; chunks: number; ultimo: string | null }[];
  ultimos: {
    tenant: string;
    memoria: string;
    doc_id: string;
    nome: string;
    tipo: string;
    ext: string;
    ocr: boolean;
    quando: string;
  }[];
  saude: { embedder: string; ocr: string; dim: number; provider: string };
};

export type UsuarioItem = {
  nome: string;
  papel: "usuario" | "operador";
  ativo: boolean;
  chave_hint: string;
  criado_em: string;
  origem_env: boolean;
  gavetas: number;
  documentos: number;
  ultimo: string | null;
};
export type UsuariosResp = { usuarios: UsuarioItem[] };
export type NovoUsuarioResp = { nome: string; papel: string; chave: string; aviso: string };

export type ProviderResp = {
  configurado: boolean;
  escopo: string | null;
  origem: "propria" | "global" | null;
  tem_global: boolean;
  tipo: "litellm" | "openai" | "ollama";
  base_url: string;
  modelo: string;
  temperatura: number;
  system_prompt: string;
  tem_system_prompt: boolean;
  mcp_interno: boolean;
  max_rodadas: number;
  ativo: boolean;
  tem_chave: boolean;
  chave_mascarada: string;
  atualizado_em: string | null;
};

/** O que o Chat chamou de ferramenta (registrado na tela e no histórico). */
export type ChamadaFerramenta = {
  servidor: string;
  nome: string;
  args: Record<string, unknown>;
  ok: boolean;
  resumo: string;
  ms: number;
};

export type ChatResp = {
  resposta: string;
  ferramentas: ChamadaFerramenta[];
  rodadas: number;
  modelo: string;
  provider: string;
  mcp_interno: boolean;
  ferramentas_ligadas: number;
  servidores: { interno: boolean; externos: number };
  tem_system_prompt: boolean;
  ms: number;
  aviso: string | null;
};
export type ChatHistorico = {
  tenant: string;
  memoria: string;
  mensagens: {
    id: number;
    papel: "user" | "assistant";
    texto: string;
    ferramentas: ChamadaFerramenta[];
    quando: string;
  }[];
};

export type ServidorMcp = {
  nome: string;
  url: string;
  ativo: boolean;
  tem_cabecalho: boolean;
  cabecalho_mascarado: string;
  ferramentas: number;
  nomes: string[];
  erro: string | null;
  atualizado_em: string;
};
export type ServidoresResp = { servidores: ServidorMcp[] };
export type TesteMcpResp = {
  nome: string;
  url: string;
  ferramentas: number;
  nomes: string[];
  servidor: string | null;
  ms: number;
};

export type ConfigResp = {
  versao: string;
  limites: Record<string, number>;
  esquecimento: { ativo: boolean; dias: number; min_acessos: number; intervalo_minutos: number };
  modelo_embedding: string;
};