"""OCR do minirag — imagem e PDF escaneado, rodando no processo do embedder.

Por que aqui e nao no Node: o leitor de texto (rapidocr, modelos PP-OCRv6 em
onnxruntime) e Python, e este processo ja existe como filho do Node. Assim o
Node nao precisa de binario novo nem de GPU: manda bytes, recebe texto.

Custo medido nesta VPS (CPU, 8 nucleos): ~4s por foto/print e ~12s por pagina
A4 a 150 dpi. Por isso o endpoint sempre roda fora da thread do asyncio
(threadpool) e o PDF tem limite de paginas.

PDF escaneado: quem rasteriza e o `pdftoppm` (poppler-utils), chamado por
subprocesso — sem biblioteca AGPL e sem canvas nativo no Node.
"""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import tempfile
import threading
import time
from typing import List, Optional, Tuple

PAGINAS_MAX = int(os.environ.get("MINIRAG_OCR_PAGINAS_MAX", "6"))
DPI = int(os.environ.get("MINIRAG_OCR_DPI", "150"))
# prints/cortes pequenos perdem linha no OCR: abaixo disso, dobra a resolucao
LARGURA_MIN = int(os.environ.get("MINIRAG_OCR_LARGURA_MIN", "900"))
ENGINE_NOME = "rapidocr/PP-OCRv6"

_engine = None
_engine_lock = threading.Lock()
_ocr_lock = threading.Lock()


class OcrErro(Exception):
    """Erro que vira 422 na API (mensagem para o usuario, nao stacktrace)."""


def disponivel() -> bool:
    try:
        import rapidocr  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception:
        return False
    return True


def _motor():
    """Carrega o leitor UMA vez (primeira chamada gasta ~2s)."""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                from rapidocr import RapidOCR

                _engine = RapidOCR()
    return _engine


def _upscale(caminho: str) -> str:
    """Imagem estreita (print pequeno, recorte) ganha 2x — medido: melhora."""
    from PIL import Image

    im = Image.open(caminho)
    if im.width >= LARGURA_MIN:
        return caminho
    saida = caminho + ".2x.png"
    im.resize((im.width * 2, im.height * 2), Image.LANCZOS).save(saida)
    return saida


def _ler_imagem(caminho: str) -> str:
    alvo = _upscale(caminho)
    try:
        with _ocr_lock:  # um OCR por vez: onnxruntime ja usa os nucleos
            res = _motor()(alvo)
    except Exception as e:  # noqa: BLE001
        raise OcrErro(f"OCR falhou nesta imagem ({e})") from e
    linhas = [t for t in (getattr(res, "txts", None) or []) if t and t.strip()]
    return "\n".join(linhas)


def _contar_paginas(pdf: str) -> int:
    try:
        saida = subprocess.run(
            ["pdfinfo", pdf], capture_output=True, text=True, timeout=60
        ).stdout
    except Exception:  # noqa: BLE001
        return 0
    for linha in saida.splitlines():
        if linha.lower().startswith("pages:"):
            try:
                return int(linha.split(":", 1)[1].strip())
            except ValueError:
                return 0
    return 0


def _rasterizar(pdf: str, pasta: str, ate: int) -> List[str]:
    """PDF -> PNG por pagina (pdftoppm). Devolve os arquivos em ordem."""
    try:
        subprocess.run(
            ["pdftoppm", "-r", str(DPI), "-png", "-f", "1", "-l", str(ate), pdf, os.path.join(pasta, "p")],
            capture_output=True,
            timeout=300,
            check=True,
        )
    except FileNotFoundError as e:
        raise OcrErro(
            "PDF escaneado precisa do poppler (pdftoppm) para virar imagem — "
            "esta instalacao nao tem"
        ) from e
    except subprocess.CalledProcessError as e:
        raise OcrErro(f"nao consegui abrir o PDF para OCR ({e.stderr.decode(errors='ignore')[:120]})") from e
    arquivos = sorted(
        (os.path.join(pasta, f) for f in os.listdir(pasta) if f.endswith(".png")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0),
    )
    return arquivos


def ocr_imagem(dados: bytes) -> Tuple[str, int]:
    with tempfile.TemporaryDirectory(prefix="ocr-") as pasta:
        caminho = os.path.join(pasta, "img.png")
        with open(caminho, "wb") as f:
            f.write(dados)
        try:
            from PIL import Image

            Image.open(caminho).verify()  # arquivo corrompido -> erro claro
        except Exception as e:  # noqa: BLE001
            raise OcrErro(f"imagem ilegivel ({e})") from e
        return _ler_imagem(caminho), 1


def ocr_pdf(dados: bytes, paginas_max: Optional[int] = None) -> Tuple[str, int]:
    limite = paginas_max or PAGINAS_MAX
    with tempfile.TemporaryDirectory(prefix="ocr-") as pasta:
        pdf = os.path.join(pasta, "doc.pdf")
        with open(pdf, "wb") as f:
            f.write(dados)
        total = _contar_paginas(pdf)
        if total and total > limite:
            raise OcrErro(
                f"este PDF tem {total} paginas e o OCR le no maximo {limite} por arquivo "
                f"(~12s por pagina). Divida o PDF e envie as partes, ou envie a versao com texto."
            )
        arquivos = _rasterizar(pdf, pasta, min(total or limite, limite))
        if not arquivos:
            raise OcrErro("nao saiu nenhuma pagina deste PDF")
        partes: List[str] = []
        for i, arq in enumerate(arquivos, start=1):
            texto = _ler_imagem(arq)
            if texto.strip():
                partes.append(f"Pagina {i}:\n{texto.strip()}")
        return "\n\n".join(partes), len(arquivos)


def processar(
    imagem_b64: Optional[str] = None,
    pdf_b64: Optional[str] = None,
    paginas_max: Optional[int] = None,
) -> dict:
    t0 = time.time()
    if imagem_b64:
        dados = base64.b64decode(imagem_b64, validate=True)
        texto, paginas = ocr_imagem(dados)
        origem = "imagem"
    elif pdf_b64:
        dados = base64.b64decode(pdf_b64, validate=True)
        texto, paginas = ocr_pdf(dados, paginas_max)
        origem = "pdf"
    else:
        raise OcrErro("envie imagem_base64 ou pdf_base64")

    if not texto.strip():
        raise OcrErro(
            "nao saiu texto desta imagem — parece foto sem texto legivel (paisagem, "
            "foto de produto). Para esse caso, descreva no nome ou na nota."
        )
    return {
        "texto": texto,
        "paginas": paginas,
        "origem": origem,
        "motor": ENGINE_NOME,
        "ms": int((time.time() - t0) * 1000),
    }