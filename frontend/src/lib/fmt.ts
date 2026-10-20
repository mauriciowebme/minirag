/** Datas relativas no padrão da casa: hoje/ontem/há N dias/dd-mm-aa. */
export function fmtData(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const agora = new Date();
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dif = Math.round((dia(agora) - dia(d)) / 86400000);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (dif === 0) return "hoje " + hora;
  if (dif === 1) return "ontem " + hora;
  if (dif > 1 && dif < 7) return `há ${dif} dias`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function slug(s: string): string {
  return s.replace(/[^\w.-]/g, "_");
}