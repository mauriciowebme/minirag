import { useCallback, useEffect, useMemo, useState } from "react";
import { get, put } from "../services/api";
import { useToast } from "./Toast";
import type { McpCatalogoResp, McpFerramenta } from "../types";

/**
 * v3.36 — tela MCP (menu lateral, visível para todo mundo).
 *
 * Duas perguntas que o usuário faz e que aqui têm resposta direta:
 *   1. "dá pra usar o minirag como servidor MCP?"  → o cartão de cima, com o endereço e o exemplo.
 *   2. "o que a MINHA conta alcança?"              → a lista, com o que ele mesmo desligou.
 *
 * A lista vem do servidor já filtrada (papel, controle de máquinas e a escolha dele) — a tela
 * não recalcula regra, só desenha.
 */
const ROTULO_MOTIVO: Record<string, string> = {
  papel: "só administrador",
  maquinas: "controle de máquinas desligado",
  desligada: "desligada por você",
  servidor_desligado: "MCP desligado pelo administrador",
};

const ORDEM_GRUPOS = ["documentos", "gavetas", "operação", "usuários", "máquinas", "pareamento"];

export function Mcp({ versao }: { versao?: string }) {
  const { toast } = useToast();
  const [dados, setDados] = useState<McpCatalogoResp | null>(null);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setDados(await get<McpCatalogoResp>("/mcp/catalogo"));
    } catch (e) {
      toast("catálogo MCP: " + (e as Error).message, "erro");
    }
  }, [toast]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const endereco = `${window.location.origin}/mcp`;

  const exemplo = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            minirag: {
              url: endereco,
              headers: { Authorization: "Bearer <chave da sua conta>" },
            },
          },
        },
        null,
        2,
      ),
    [endereco],
  );

  async function copiar(texto: string, chave: string) {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(chave);
      setTimeout(() => setCopiado(null), 1800);
    } catch {
      toast("o navegador não deixou copiar; selecione o texto", "erro");
    }
  }

  async function alternar(f: McpFerramenta, permitida: boolean) {
    setSalvando(f.nome);
    try {
      await put<{ ferramenta: string; permitida: boolean }>("/mcp/ferramentas", {
        ferramenta: f.nome,
        permitida,
      });
      await carregar();
      toast(permitida ? `${f.nome} liberada` : `${f.nome} desligada`, "sucesso");
    } catch (e) {
      toast("ferramenta: " + (e as Error).message, "erro");
    } finally {
      setSalvando(null);
    }
  }

  const grupos = useMemo(() => {
    const mapa = new Map<string, McpFerramenta[]>();
    for (const f of dados?.ferramentas ?? []) {
      const lista = mapa.get(f.grupo) ?? [];
      lista.push(f);
      mapa.set(f.grupo, lista);
    }
    return [...mapa.entries()].sort(
      (a, b) => ORDEM_GRUPOS.indexOf(a[0]) - ORDEM_GRUPOS.indexOf(b[0]) || a[0].localeCompare(b[0]),
    );
  }, [dados]);

  const liberadas = (dados?.ferramentas ?? []).filter((f) => f.permitida).length;
  const total = dados?.ferramentas.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="cartao">
        <h2 className="mb-1 text-[13px] font-semibold text-txt2">Usar o minirag como servidor MCP</h2>
        <p className="dica mt-0 mb-3">
          Seu agente (Hermes, Claude, Cursor, um script) pode conversar com o minirag por MCP: buscar, guardar,
          editar documentos e usar as ferramentas liberadas abaixo. A credencial é a <b>chave da sua conta</b> — a
          mesma que abre esta tela; não existe cadastro separado.
        </p>
        {dados && !dados.habilitado && (
          <p className="aviso" id="mcpDesligado">
            O administrador desligou o uso do MCP para contas comuns. A lista abaixo mostra o que voltaria a valer
            quando ele religar.
          </p>
        )}
        <div className="space-y-2">
          <div>
            <span className="dica">endereço</span>
            <div className="flex items-center gap-2">
              <code id="mcpEndereco">{endereco}</code>
              <button className="btn btn-mini" type="button" onClick={() => void copiar(endereco, "url")}>
                {copiado === "url" ? "copiado" : "copiar"}
              </button>
            </div>
          </div>
          <div>
            <span className="dica">cabeçalho</span>
            <div className="flex items-center gap-2">
              <code id="mcpCabecalho">Authorization: Bearer &lt;chave da sua conta&gt;</code>
            </div>
          </div>
          <div>
            <span className="dica">para colar num cliente MCP</span>
            <pre id="mcpExemplo" className="bloco-codigo">{exemplo}</pre>
            <button className="btn btn-mini" type="button" onClick={() => void copiar(exemplo, "json")}>
              {copiado === "json" ? "copiado" : "copiar exemplo"}
            </button>
          </div>
          <p className="dica mb-0">
            Sem a chave em mãos? Peça ao administrador uma nova em <b>Usuários → chave</b> — ela aparece uma única vez.
            {versao ? ` Versão do servidor: ${versao}.` : ""}
          </p>
        </div>
      </div>

      <div className="cartao">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="mb-0 text-[13px] font-semibold text-txt2">Ferramentas desta conta</h2>
          <span className="dica" id="mcpContador">
            {liberadas} de {total} liberadas
          </span>
        </div>
        <p className="dica mt-0 mb-3">
          Desligue o que o seu agente não deve alcançar. Ferramenta nova nasce <b>liberada</b>; as de administração
          continuam exclusivas do administrador, e as de máquina dependem do controle ligado no servidor.
        </p>

        {grupos.map(([grupo, lista]) => (
          <div key={grupo} className="mb-4">
            <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-txt2">{grupo}</h3>
            <table className="tabela" id={`mcpGrupo-${grupo}`}>
              <thead>
                <tr>
                  <th>ferramenta</th>
                  <th>o que faz</th>
                  <th className="w-24">liberada</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((f) => (
                  <tr key={f.nome} className={f.permitida ? "" : "esmaecida"}>
                    <td className="font-mono text-[12px]">{f.nome}</td>
                    <td className="text-[12px]">
                      {f.descricao}
                      {f.motivo ? <span className="dica block"> · {ROTULO_MOTIVO[f.motivo] ?? f.motivo}</span> : null}
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`liberar ${f.nome}`}
                        data-ferramenta={f.nome}
                        checked={f.permitida}
                        disabled={!f.ajustavel || salvando === f.nome}
                        onChange={(e) => void alternar(f, e.target.checked)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
