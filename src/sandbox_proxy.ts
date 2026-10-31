/**
 * T053 — proxy de saída do sandbox.
 *
 * O script Python não fala com a internet direto: ele recebe HTTP_PROXY/HTTPS_PROXY
 * apontando para este proxy, que roda no mesmo processo Node, em 127.0.0.1.
 *
 * A regra é a mesma do `web_open`: só http/https públicos. Qualquer destino que
 * resolva para endereço interno (loopback, rede privada, link-local, metadados) é
 * recusado ANTES de abrir a conexão — e fica registrado no log com quem pediu.
 */
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { enderecoInterno } from "./web";

export type DestinoProxy = { alvo: string; quando: string; motivo?: string };

export type ProxySandbox = {
  porta: number;
  destinos: DestinoProxy[];
  fechar: () => Promise<void>;
};

const MAX_LOG = 200;

/** Resolve o host e recusa se qualquer endereço for interno. Devolve o IP a usar. */
async function resolverPublico(host: string): Promise<string> {
  const limpo = host.replace(/^\[|\]$/g, "");
  if (enderecoInterno(limpo)) throw new Error("endereco interno nao permitido");
  if (net.isIP(limpo)) return limpo;
  const { address } = await lookup(limpo, { verbatim: true });
  if (enderecoInterno(address)) throw new Error("endereco interno nao permitido");
  return address;
}

export async function subirProxy(porta = 0): Promise<ProxySandbox> {
  const destinos: DestinoProxy[] = [];
  const anotar = (alvo: string, motivo?: string) => {
    destinos.push({ alvo, quando: new Date().toISOString(), ...(motivo ? { motivo } : {}) });
    if (destinos.length > MAX_LOG) destinos.shift();
  };

  const servidor = http.createServer((req, res) => {
    /* HTTP simples (sem CONNECT): o alvo vem na própria URL. */
    let alvo: URL;
    try {
      alvo = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("destino invalido");
      anotar(req.url ?? "?", "url invalida");
      return;
    }
    resolverPublico(alvo.hostname)
      .then((ip) => {
        anotar(alvo.href);
        req.on("error", () => res.destroy());
        res.on("error", () => undefined);
        const prox = http.request(
          {
            host: ip,
            port: Number(alvo.port || 80),
            path: alvo.pathname + alvo.search,
            method: req.method,
            headers: { ...req.headers, host: alvo.host },
          },
          (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
          },
        );
        prox.on("error", () => res.writeHead(502).end("falha no destino"));
        req.pipe(prox);
      })
      .catch((e: Error) => {
        anotar(alvo.href, e.message);
        res.writeHead(403).end(e.message);
      });
  });

  /* HTTPS: o cliente pede CONNECT host:porta e nós abrimos o túnel.
     Todo socket tem handler de erro: sem isso um RST do destino vira "unhandled 'error'"
     e derruba o processo Node inteiro (medido em 30/10). */
  servidor.on("connect", (req, cliente, cabeca) => {
    const [host, portaTxt] = String(req.url ?? "").split(":");
    const portaDestino = Number(portaTxt || 443);
    cliente.on("error", () => cliente.destroy());
    resolverPublico(host ?? "")
      .then((ip) => {
        const alvo = net.connect(portaDestino, ip, () => {
          anotar(`${host}:${portaDestino}`);
          cliente.write("HTTP/1.1 200 Conexao estabelecida\r\n\r\n");
          if (cabeca?.length) alvo.write(cabeca);
          alvo.pipe(cliente);
          cliente.pipe(alvo);
        });
        alvo.on("error", () => {
          cliente.destroy();
        });
        alvo.on("close", () => cliente.destroy());
        cliente.on("close", () => alvo.destroy());
      })
      .catch((e: Error) => {
        anotar(`${host}:${portaDestino}`, e.message);
        cliente.end(`HTTP/1.1 403 Forbidden\r\n\r\n${e.message}`);
      });
  });

  servidor.on("clientError", (_e, socket) => socket.destroy());

  await new Promise<void>((ok, falha) => {
    servidor.once("error", falha);
    servidor.listen(porta, "127.0.0.1", () => ok());
  });
  const endereco = servidor.address();
  const escolhida = typeof endereco === "object" && endereco ? endereco.port : porta;
  return {
    porta: escolhida,
    destinos,
    fechar: () =>
      new Promise<void>((ok) => {
        servidor.closeAllConnections?.();
        servidor.close(() => ok());
      }),
  };
}
