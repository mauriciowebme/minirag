#!/usr/bin/env bash
# Build dos clientes de máquina (Node SEA): um binário por plataforma, sem
# instalação, com a VERSÃO DO PRODUTO embutida (auto-update compara com o
# servidor). Roda localmente e dentro do estágio `cliente` do Dockerfile.
#
# Saída: agente/bin/minirag-cliente-linux  +  agente/bin/minirag-cliente-win.exe
#
# Receita oficial do Node Single Executable Application:
#   1. gera o blob (sea-config) com O MESMO node que vai receber a injeção;
#   2. copia o binário do node (linux = o daqui; windows = o dist oficial da
#      MESMA versão) e injeta o blob com postject;
#   3. no Windows tira a assinatura Authenticode ANTES (injetar em PE assinado
#      deixa o binário corrompido; é o passo que o signtool remove /s faria).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSAO=$(grep -o 'versao: "[^"]*"' src/config.ts | cut -d'"' -f2)
[ -n "$VERSAO" ] || { echo "build-cliente: não li a versão de src/config.ts" >&2; exit 1; }
NVER=$(node --version); NVER=${NVER#v}
FUSE=NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
mkdir -p agente/bin agente/.build

echo "==> cliente v$VERSAO (node $NVER)"

# 1) versão entra no código ANTES do blob (o cliente compara com /maquina/atualizacao)
sed 's#|| "dev"#|| "'"$VERSAO"'"#' agente/cliente.js > agente/.build/cliente.js
node --check agente/.build/cliente.js   # fumaça: sintaxe; rodar aqui abriria conexão de verdade
printf '{"main":"agente/.build/cliente.js","output":"agente/.build/sea.blob"}\n' > agente/.build/sea-config.json
node --experimental-sea-config agente/.build/sea-config.json 2>/dev/null || node --build-sea agente/.build/sea-config.json

# 2) linux: copia o node que está rodando o build e injeta
LINUX_BIN=$(readlink -f "$(command -v node)")
cp "$LINUX_BIN" agente/bin/minirag-cliente-linux
chmod u+w agente/bin/minirag-cliente-linux
npx --yes postject@1.0.0-alpha.5 agente/bin/minirag-cliente-linux NODE_SEA_BLOB agente/.build/sea.blob --sentinel-fuse "$FUSE" >/dev/null
echo "==> agente/bin/minirag-cliente-linux ($(stat -c%s agente/bin/minirag-cliente-linux) bytes)"

# 3) windows: mesmo node, versão do dist oficial, PE assinado -> tira a assinatura -> injeta
if [ "${1:-}" != "--sem-win" ]; then
  ZIP=agente/.build/node-win.zip
  if [ ! -f "$ZIP" ]; then
    curl -fsSL "https://nodejs.org/dist/v${NVER}/node-v${NVER}-win-x64.zip" -o "$ZIP"
  fi
  python3 - "$ZIP" agente/.build/node.exe <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
nome = [n for n in z.namelist() if n.endswith("node.exe")][0]
open(sys.argv[2], "wb").write(z.read(nome))
PY
  python3 scripts/strip_pe_assinatura.py agente/.build/node.exe
  npx --yes postject@1.0.0-alpha.5 agente/.build/node.exe NODE_SEA_BLOB agente/.build/sea.blob --sentinel-fuse "$FUSE" >/dev/null
  mv agente/.build/node.exe agente/bin/minirag-cliente-win.exe
  # v3.11: sem console — o programa abre a própria janela e nada mais
  python3 scripts/sem_console_pe.py agente/bin/minirag-cliente-win.exe
  echo "==> agente/bin/minirag-cliente-win.exe ($(stat -c%s agente/bin/minirag-cliente-win.exe) bytes)"
fi

echo "==> pronto"
