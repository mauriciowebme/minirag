#!/usr/bin/env python3
"""Troca o subsistema do .exe de CONSOLE (3) para JANELA/GUI (2).

Sem isso, o Windows abre uma janela preta junto do programa — o dono pediu
UMA janela só (v3.11). O cabeçalho PE guarda o subsistema em
e_lfanew + 0x5C (2 bytes); 2 = Windows GUI, 3 = console.
"""
import struct
import sys

CAMINHO = sys.argv[1] if len(sys.argv) > 1 else "agente/bin/minirag-cliente-win.exe"

d = bytearray(open(CAMINHO, "rb").read())
if d[:2] != b"MZ":
    sys.exit("nao e um executavel PE: " + CAMINHO)
e_lfanew = struct.unpack_from("<I", d, 0x3C)[0]
if d[e_lfanew:e_lfanew + 4] != b"PE\0\0":
    sys.exit("cabecalho PE invalido: " + CAMINHO)
off = e_lfanew + 0x5C
antes = struct.unpack_from("<H", d, off)[0]
struct.pack_into("<H", d, off, 2)
open(CAMINHO, "wb").write(d)
depois = struct.unpack_from("<H", open(CAMINHO, "rb").read(), off)[0]
print("subsistema: %d -> %d (2 = janela, sem console)" % (antes, depois))
if depois != 2:
    sys.exit("falhou trocar o subsistema")