#!/usr/bin/env python3
"""Remove a assinatura Authenticode de um PE (Windows .exe) antes do postject.

Injetar dados num PE assinado quebra a assinatura de qualquer jeito; o caminho
oficial (signtool remove /s) não existe fora do Windows, e a receita da doc do
Node é o binário chegar SEM tabela de certificados. Este script:

  1. localiza o data directory #4 (IMAGE_DIRECTORY_ENTRY_SECURITY);
  2. zera a entrada (VA + tamanho) — o loader ignora;
  3. corta o arquivo no offset do certificado (ele vive no fim, é lixo seguro).

Sem assinatura o antivírus já ia desconfiar de qualquer forma (exe não assinado
era o motivo que tirou o Go da jogada); o que este passo evita é o pior caso:
PE que nem carrega.
"""
import struct
import sys

path = sys.argv[1]
data = bytearray(open(path, "rb").read())

e_lfanew = struct.unpack_from("<I", data, 0x3C)[0]
if data[e_lfanew:e_lfanew + 4] != b"PE\x00\x00":
    sys.exit("não é PE válido")
coff = e_lfanew + 4
opt = coff + 20
magic = struct.unpack_from("<H", data, opt)[0]
dd = opt + (112 if magic == 0x20B else 96)  # PE32+ / PE32
ENTRY = 4  # SECURITY
va, size = struct.unpack_from("<II", data, dd + ENTRY * 8)

if va == 0 or size == 0:
    print("sem assinatura — nada a fazer")
    sys.exit(0)

if va + size > len(data) or va < len(data) - size:
    sys.exit(f"certificado em {va}+{size} não encosta no fim ({len(data)} bytes) — formato inesperado, não corto às cegas")

struct.pack_into("<II", data, dd + ENTRY * 8, 0, 0)
out = bytes(data[:va])
open(path, "wb").write(out)
print(f"assinatura removida: cortei {size} bytes, arquivo foi a {len(out)}")
