import { useCallback, useEffect, useState } from "react";
import { get, post, qs } from "../services/api";
import { useToast } from "./Toast";
import type { Job, JobsResp } from "../types";

const TAG_JOB: Record<string, string> = {
  concluido: "tag-ativo",
  erro: "tag-erro",
  processando: "tag-processando",
  na_fila: "tag-fila",
  cancelado: "tag-arquivado",
};
const ROT_JOB: Record<string, string> = { concluido: "concluído" };

export function Jobs({ tenant, nome, operador }: { tenant: string; nome: string; operador: boolean }) {
  const { toast } = useToast();
  const [status, setStatus] = useState("");
  const [dados, setDados] = useState<JobsResp | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(
    async (st: string) => {
      setCarregando(true);
      try {
        setDados(
          await get<JobsResp>(
            "/jobs?" + qs({ limit: 80, status: st, tenant: operador ? tenant : nome }),
          ),
        );
      } catch (e) {
        setDados(null);
        toast("jobs: " + (e as Error).message);
      } finally {
        setCarregando(false);
      }
    },
    [nome, operador, tenant, toast],
  );

  useEffect(() => {
    void carregar("");
  }, [carregar]);

  async function cancelar(job: Job) {
    try {
      await post(`/jobs/${job.job_id}/cancel?` + qs({ tenant: operador ? job.tenant : "" }));
      toast("job cancelado");
      void carregar(status);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function retentar(job: Job) {
    try {
      await post(`/jobs/${job.job_id}/retry?` + qs({ tenant: operador ? job.tenant : "" }));
      toast("job reenfileirado");
      void carregar(status);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const resumo = dados
    ? Object.entries(dados.resumo_por_status)
        .map(([k, v]) => `${ROT_JOB[k] || k}: ${v}`)
        .join("   ·   ") || "sem jobs"
    : "";

  return (
    <section>
      <div className="barra">
        <h2>Fila de ingestão</h2>
        <span className="flex-1" />
        <select
          id="jobStatus"
          aria-label="filtrar por status"
          className="campo w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            void carregar(e.target.value);
          }}
        >
          <option value="">todos os status</option>
          <option value="na_fila">na_fila</option>
          <option value="processando">processando</option>
          <option value="concluido">concluido</option>
          <option value="erro">erro</option>
          <option value="cancelado">cancelado</option>
        </select>
        <button
          id="btnJobs"
          className="btn"
          title="recarregar a lista"
          onClick={() => void carregar(status)}
        >
          <span aria-hidden="true">⟳</span>
          atualizar
        </button>
      </div>

      <div id="jobsInfo" className="dica">
        {resumo}
      </div>

      <table className="tabela" id="jobsTabela">
        <thead>
          <tr>
            <th className="num">job</th>
            <th>tenant</th>
            <th>gaveta</th>
            <th>doc_id</th>
            <th>estado</th>
            <th className="num">progresso</th>
            <th>erro</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {carregando && (
            <tr>
              <td colSpan={8} className="text-txt3">
                carregando…
              </td>
            </tr>
          )}
          {!carregando && dados?.jobs.length === 0 && (
            <tr>
              <td colSpan={8} className="text-txt3">
                fila vazia
              </td>
            </tr>
          )}
          {!carregando &&
            dados?.jobs.map((job) => (
              <tr key={job.job_id}>
                <td className="num" data-rot="job">
                  {job.job_id}
                </td>
                <td data-rot="tenant">{job.tenant}</td>
                <td data-rot="gaveta">{job.memoria || "(padrão)"}</td>
                <td data-rot="doc_id">
                  <span className="tcode">{job.doc_id}</span>
                </td>
                <td data-rot="estado">
                  <span className={`tag ${TAG_JOB[job.status] || "tag-fila"}`}>
                    {ROT_JOB[job.status] || job.status.replace("_", " ")}
                  </span>
                </td>
                <td className="num" data-rot="progresso">
                  {job.chunks_feitos}/{job.chunks_total}
                </td>
                <td data-rot="erro" className={job.erro ? "" : "celula-vazia"}>
                  <span className="text-[13px] text-vermelho" title={job.erro || ""}>
                    {job.erro || ""}
                  </span>
                </td>
                <td className="acoes">
                  <span className="acoes-linha">
                    {job.status === "na_fila" && (
                      <button className="btn btn-sutil btn-mini" onClick={() => void cancelar(job)}>
                        cancelar
                      </button>
                    )}
                    {(job.status === "erro" || job.status === "cancelado") && (
                      <button className="btn btn-sutil btn-mini" onClick={() => void retentar(job)}>
                        retentar
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}