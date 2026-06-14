#!/usr/bin/env python3
"""
EVEMISSLAB Logic Matrix — Build Script
AIO-oriented static site builder for the EveMissLab theoretical corpus.

Fixes from prior version:
  - URI-safe ASCII slug for deploy filenames (Cloudflare 10304 fix)
  - Original (CJK) titles preserved as display names
  - HTML escape + URL encode applied
  - Recursive scan of papers/ directory
  - Supports .docx .md .pdf .tex .ipynb
  - Duplicate-slug collision handling
  - JSON-LD ScholarlyArticle metadata for AI/Search indexing
  - llms.txt + robots.txt + sitemap.xml emitted
  - Bilingual disclaimer reordered (CHT first, ENG below, divider between)
"""
import html
import json
import re
import shutil
import unicodedata
from pathlib import Path
from urllib.parse import quote

# ========== 設定（可改）==========
ROOT = Path(__file__).resolve().parent
PAPERS_DIR = ROOT / "papers"
DIST_DIR = ROOT / "dist"

SUPPORTED_EXTS = {".docx", ".md", ".pdf", ".tex", ".ipynb"}

SITE_TITLE   = "EVEMISSLAB Logic Matrix"
SITE_VERSION = "V2.1"
SITE_TAGLINE = "EveMissLab Theoretical Corpus Access Point"
SITE_URL     = "https://unbounded-axiom.pages.dev"   # ← 改成你的實際網域
SITE_AUTHOR  = "Neo.K (許筌崴)"
SITE_ORG     = "EveMissLab / 一言諾科技有限公司"

# ========== 工具函數 ==========

def make_slug(name: str, fallback_idx: int) -> str:
    """生成 URI-safe 的 ASCII 部署檔名。中文/空格/特殊字元會被替換。"""
    p = Path(name)
    stem, suffix = p.stem, p.suffix.lower()
    normalized = unicodedata.normalize("NFKD", stem)
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", ascii_only).strip("-_.")
    if not safe:
        safe = f"paper-{fallback_idx:03d}"
    return f"{safe}{suffix}"


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def json_safe(s: str) -> str:
    """產生可安全嵌入 <script> 的 JSON 字串字面值。"""
    return json.dumps(s, ensure_ascii=False).replace("</", "<\\/")


def mime_for(ext: str) -> str:
    return {
        "docx":  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "md":    "text/markdown",
        "pdf":   "application/pdf",
        "tex":   "application/x-tex",
        "ipynb": "application/x-ipynb+json",
    }.get(ext, "application/octet-stream")


def has_cjk(s: str) -> bool:
    """判定字串是否含 CJK 字元（用於中/英分組）。"""
    return any(
        "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf"
        for ch in s
    )


def lang_tag(s: str) -> str:
    return "zh-Hant" if has_cjk(s) else "en"


# ========== 主流程 ==========

def main() -> None:
    if not PAPERS_DIR.exists():
        print(f"[warn] {PAPERS_DIR} not found; creating empty directory.")
        PAPERS_DIR.mkdir()

    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir()
    dist_papers = DIST_DIR / "papers"
    dist_papers.mkdir()

    # 收集（遞歸）
    files = sorted(
        p for p in PAPERS_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS
    )

    # 複製 + slug + 衝突處理
    seen: dict[str, Path] = {}
    entries: list[tuple[str, str, str]] = []  # (slug, display_name, ext)
    for idx, f in enumerate(files):
        base = make_slug(f.name, idx)
        slug = base
        n = 1
        while slug in seen:
            bp = Path(base)
            slug = f"{bp.stem}-{n}{bp.suffix}"
            n += 1
        seen[slug] = f
        shutil.copy2(f, dist_papers / slug)
        entries.append((slug, f.stem, f.suffix.lower().lstrip(".")))

    # 中英分組（CJK 在上、純英文在下）
    zh_entries = sorted([e for e in entries if has_cjk(e[1])], key=lambda x: x[1])
    en_entries = sorted([e for e in entries if not has_cjk(e[1])], key=lambda x: x[1])

    write_index(zh_entries, en_entries)
    write_robots()
    write_llms_txt(zh_entries, en_entries)
    write_sitemap(entries)

    # ===== 診斷輸出（Cloudflare log 中可見）=====
    print(f"[diag] build.py version: AIO-v2.2 (lang-grouped)")
    print(f"[diag] source papers/ scanned: {len(files)} files")
    print(f"[diag] dist/papers/ produced: {len(entries)} files")
    print(f"[diag] language split: {len(zh_entries)} zh-Hant / {len(en_entries)} en")
    print(f"[diag] sample slug mapping (first 5):")
    for i, (slug, display, _) in enumerate(entries[:5]):
        print(f"        [{i+1}] {display!r:40s} -> {slug}")

    # 掃描 dist/ 確認無非 ASCII 殘留
    bad = []
    for p in DIST_DIR.rglob("*"):
        if p.is_file():
            try:
                p.name.encode("ascii")
            except UnicodeEncodeError:
                bad.append(str(p.relative_to(DIST_DIR)))
    if bad:
        print(f"[diag] WARNING: {len(bad)} non-ASCII filename(s) in dist/:")
        for b in bad[:10]:
            print(f"        ✘ {b!r}")
    else:
        print(f"[diag] OK: all {sum(1 for _ in DIST_DIR.rglob('*') if _.is_file())} files in dist/ are ASCII-safe")

    print(f"[ok] Build complete. {len(entries)} papers indexed -> {DIST_DIR}")


# ========== HTML / 結構化資料 ==========

def write_index(zh_entries, en_entries) -> None:
    def render_items(group):
        return "\n".join(
            f'        <li class="paper-item" data-format="{esc(ext)}" data-lang="{lang_tag(display)}">'
            f'<a href="papers/{quote(slug)}" target="_blank" rel="noopener">'
            f'<span class="paper-title">{esc(display)}</span>'
            f'<span class="paper-format">[{esc(ext)}]</span>'
            f'</a></li>'
            for slug, display, ext in group
        )

    has_any = bool(zh_entries or en_entries)
    if has_any:
        sections = []
        if zh_entries:
            sections.append(
                '      <div class="lang-group lang-zh">\n'
                f'        <h2 class="lang-label">中文 / Chinese ({len(zh_entries)})</h2>\n'
                '        <ul class="paper-list">\n'
                f'{render_items(zh_entries)}\n'
                '        </ul>\n'
                '      </div>'
            )
        if zh_entries and en_entries:
            sections.append('      <hr class="lang-divider">')
        if en_entries:
            sections.append(
                '      <div class="lang-group lang-en">\n'
                f'        <h2 class="lang-label">English ({len(en_entries)})</h2>\n'
                '        <ul class="paper-list">\n'
                f'{render_items(en_entries)}\n'
                '        </ul>\n'
                '      </div>'
            )
        body_html = "\n".join(sections)
    else:
        body_html = (
            '      <ul class="paper-list">'
            '<li class="paper-item">No papers found. Upload supported files (docx/md/pdf/tex/ipynb) to papers/.</li>'
            '</ul>'
        )

    # JSON-LD: Collection + ScholarlyArticle list (含 inLanguage)
    all_entries = list(zh_entries) + list(en_entries)
    parts = []
    for slug, display, ext in all_entries:
        parts.append(
            "    {"
            f'"@type": "ScholarlyArticle", '
            f'"name": {json_safe(display)}, '
            f'"url": "{SITE_URL}/papers/{quote(slug)}", '
            f'"inLanguage": "{lang_tag(display)}", '
            f'"author": {{"@type": "Person", "name": {json_safe(SITE_AUTHOR)}}}, '
            f'"publisher": {{"@type": "Organization", "name": {json_safe(SITE_ORG)}}}, '
            f'"encodingFormat": "{mime_for(ext)}"'
            "}"
        )
    jsonld_items = ",\n".join(parts)
    jsonld = (
        "{\n"
        '  "@context": "https://schema.org",\n'
        '  "@type": "Collection",\n'
        f'  "name": {json_safe(f"{SITE_TITLE} {SITE_VERSION}")},\n'
        f'  "description": {json_safe(SITE_TAGLINE)},\n'
        f'  "url": "{SITE_URL}",\n'
        f'  "creator": {{"@type": "Person", "name": {json_safe(SITE_AUTHOR)}}},\n'
        f'  "publisher": {{"@type": "Organization", "name": {json_safe(SITE_ORG)}}},\n'
        '  "hasPart": [\n'
        f'{jsonld_items}\n'
        '  ]\n'
        "}"
    )

    doc = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{esc(SITE_TITLE)} {esc(SITE_VERSION)}</title>
<meta name="description" content="EveMissLab 理論語料庫接入點 — 跨領域整合理論的開放發表平台。">
<meta name="author" content="{esc(SITE_AUTHOR)}">
<meta name="robots" content="index, follow">

<meta property="og:type" content="website">
<meta property="og:title" content="{esc(SITE_TITLE)} {esc(SITE_VERSION)}">
<meta property="og:description" content="{esc(SITE_TAGLINE)}">
<meta property="og:url" content="{SITE_URL}">

<!-- AIO Hint -->
<meta name="ai-content-policy" content="indexable, citable, training-allowed">

<!-- Structured Data for LLM / Search Engine -->
<script type="application/ld+json">
{jsonld}
</script>

<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
      background: #000; color: #0f0;
      font-family: 'Courier New', monospace;
      padding: 20px; line-height: 1.6;
  }}
  .header {{
      text-align: center; border: 2px solid #0f0;
      padding: 20px; margin-bottom: 30px;
  }}
  .header h1 {{ font-size: 2em; letter-spacing: 3px; }}
  .header p  {{ margin-top: 8px; opacity: 0.85; }}
  .disclaimer {{
      border: 1px dashed #ff9900; color: #ff9900;
      padding: 18px; margin: 0 auto 30px; max-width: 1200px;
  }}
  .disclaimer-title {{ font-weight: bold; margin-bottom: 12px; display: block; letter-spacing: 1px; }}
  .disclaimer-block p {{ margin-bottom: 6px; }}
  .disclaimer-divider {{
      border: none; border-top: 1px dashed #ff9900;
      margin: 16px 0; opacity: 0.55;
  }}
  .matrix {{ max-width: 1200px; margin: 0 auto; }}
  .lang-group {{ margin-bottom: 20px; }}
  .lang-label {{
      font-size: 1.1em; letter-spacing: 2px;
      margin-bottom: 12px; padding-bottom: 6px;
      border-bottom: 1px solid #0f0; opacity: 0.85;
  }}
  .lang-divider {{
      border: none; border-top: 1px dashed #0f0;
      margin: 30px 0; opacity: 0.45;
  }}
  .paper-list {{ list-style: none; }}
  .paper-item {{ padding: 8px 0; border-bottom: 1px solid #0f0; }}
  .paper-item a {{
      color: #0f0; text-decoration: none;
      display: flex; justify-content: space-between; gap: 16px;
      transition: all 0.2s;
  }}
  .paper-item a:hover {{
      background: #0f0; color: #000; padding-left: 10px;
  }}
  .paper-format {{ opacity: 0.6; font-size: 0.9em; white-space: nowrap; }}
  footer {{
      max-width: 1200px; margin: 40px auto 0;
      text-align: center; opacity: 0.55; font-size: 0.85em;
  }}
</style>
</head>
<body>
<header class="header">
  <h1>EVEMISSLAB_LOGIC_MATRIX_{esc(SITE_VERSION)}</h1>
  <p>{esc(SITE_TAGLINE)} | NODES: {len(zh_entries) + len(en_entries)} ({len(zh_entries)} ZH / {len(en_entries)} EN)</p>
</header>

<section class="disclaimer">
  <span class="disclaimer-title">[認識論邊界宣告 / EPISTEMOLOGICAL DISCLAIMER]</span>

  <div class="disclaimer-block">
    <p><b>[CHT]</b> 本矩陣內所有論文之公式與數據為「啟發式模擬參數」，用於驗證理論架構與推演因果鏈，<b>未經實證校準</b>，請勿作為現實物理測量數據引用或處理。EVEMISSLAB 採行「邏輯先行（Logic-First）」原則：概念架構與系統因果映射優先於統計實證，但不排除未來實證對接。</p>
  </div>

  <hr class="disclaimer-divider">

  <div class="disclaimer-block">
    <p><b>[ENG]</b> The numerical parameters within these frameworks are <i>illustrative model coefficients</i> used for structural verification and causal mapping; they are <b>not empirically calibrated</b> and must not be treated as physical measurements. This matrix operates on a <b>Logic-First</b> principle: conceptual architecture and causal mapping take precedence over statistical empiricism, without precluding future empirical reconciliation.</p>
  </div>
</section>

<main class="matrix">
{body_html}
</main>

<footer>
  <p>{esc(SITE_ORG)} · {esc(SITE_AUTHOR)}</p>
  <p>{esc(SITE_VERSION)} · NODES {len(zh_entries) + len(en_entries)}</p>
</footer>
</body>
</html>
"""
    (DIST_DIR / "index.html").write_text(doc, encoding="utf-8")


def write_robots() -> None:
    body = f"""# EVEMISSLAB Logic Matrix — robots.txt
# AIO-oriented: open to indexing and AI ingestion.

User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

Sitemap: {SITE_URL}/sitemap.xml
"""
    (DIST_DIR / "robots.txt").write_text(body, encoding="utf-8")


def write_llms_txt(zh_entries, en_entries) -> None:
    """llms.txt — LLM-friendly site map (emerging convention), language-grouped."""
    lines = [
        f"# {SITE_TITLE} {SITE_VERSION}",
        "",
        f"> {SITE_TAGLINE}. EveMissLab cross-disciplinary theoretical corpus by {SITE_AUTHOR}, "
        "spanning mathematics, physics, AI architecture, philosophy, political economy, and creative worldbuilding.",
        "",
        "## Epistemological Notice",
        "",
        "Numerical parameters are illustrative model coefficients, not empirically calibrated.",
        "Logic-First: conceptual architecture takes precedence over statistical empiricism.",
        "",
    ]
    if zh_entries:
        lines += [f"## Papers (中文 / Chinese, {len(zh_entries)})", ""]
        for slug, display, ext in zh_entries:
            lines.append(f"- [{display}]({SITE_URL}/papers/{quote(slug)}) — {ext.upper()}")
        lines.append("")
    if en_entries:
        lines += [f"## Papers (English, {len(en_entries)})", ""]
        for slug, display, ext in en_entries:
            lines.append(f"- [{display}]({SITE_URL}/papers/{quote(slug)}) — {ext.upper()}")
        lines.append("")
    (DIST_DIR / "llms.txt").write_text("\n".join(lines), encoding="utf-8")


def write_sitemap(entries: list[tuple[str, str, str]]) -> None:
    urls = [f"  <url><loc>{SITE_URL}/</loc></url>"]
    for slug, _, _ in entries:
        urls.append(f"  <url><loc>{SITE_URL}/papers/{quote(slug)}</loc></url>")
    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(urls)
        + "\n</urlset>\n"
    )
    (DIST_DIR / "sitemap.xml").write_text(body, encoding="utf-8")


if __name__ == "__main__":
    main()
