#!/bin/bash
# Build bilingual docs site: auto-translate → English (site/) + Chinese (site/zh/)
#
# Prerequisites:
#   pip install mkdocs-material deep-translator
#
# Usage:
#   bash scripts/build-docs.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1. Translating docs/ → docs-zh/ ==="
python scripts/translate-docs.py

echo "     Copying research/, ai/, sdk/, overrides/ → docs-zh/"
rm -rf docs-zh/research docs-zh/ai docs-zh/sdk docs-zh/overrides
cp -r docs/research docs-zh/research 2>/dev/null || true
cp -r docs/ai docs-zh/ai 2>/dev/null || true
cp -r docs/sdk docs-zh/sdk 2>/dev/null || true
cp -r docs/overrides docs-zh/overrides 2>/dev/null || true

echo ""
echo "=== 2. Generating bilingual mkdocs configs ==="
python3 -c "
import yaml, copy
from urllib.parse import urlparse

with open('mkdocs.yml') as f:
    en_cfg = yaml.safe_load(f)

# Extract path from site_url (e.g. /nexus-chat/ → /nexus-chat)
site_url = en_cfg.get('site_url', '')
path = urlparse(site_url).path.rstrip('/') if site_url else ''

# --- English config ---
en_cfg.setdefault('extra', {})['alternate'] = [
    {'name': 'English', 'link': path + '/',        'lang': 'en'},
    {'name': '中文',    'link': path + '/zh/',      'lang': 'zh'},
]
with open('mkdocs-en.yml', 'w', encoding='utf-8') as f:
    yaml.dump(en_cfg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

# --- Chinese config ---
zh_cfg = copy.deepcopy(en_cfg)
zh_cfg['docs_dir'] = 'docs-zh'
zh_cfg['site_dir'] = 'site/zh'
zh_cfg['site_url'] = (site_url.rstrip('/') if site_url else '') + '/zh/'
zh_cfg.setdefault('theme', {})['language'] = 'zh'

# Translate nav labels (static mapping + auto-translate fallback)
MAP = {
    'Home': '首页',
    'Design Documents': '设计文档',
    'Implementation Tasks': '实施任务',
    'System High-Level Architecture': '系统总体架构',
    'Client Shell & UI Rendering': '客户端外壳与 UI 渲染层',
    'Long Connection & Core Gateway': '长连接与核心网关层',
    'Business Logic & Persistence': '业务逻辑与持久化后端',
    'Async Bot Engine & Event Dispatch': '异步 Bot 引擎与事件分发层',
    'AI Agent Orchestration & Streaming': 'AI Agent 编排与流式引擎',
    'Phase Roadmap': '阶段路线图',
    'Phase 1 — Project Scaffold': 'Phase 1 — 项目脚手架',
    'Phase 1 — Shared Contracts': 'Phase 1 — 共享契约',
    'Phase 1 — Database Schema': 'Phase 1 — 数据库模型',
    'Phase 1 — Auth & Security': 'Phase 1 — 认证与安全',
    'Phase 1 — Core Gateway': 'Phase 1 — 核心网关',
    'Phase 1 — Workspace & Channel': 'Phase 1 — 工作区与频道',
    'Phase 1 — Message Service': 'Phase 1 — 消息服务',
    'Phase 1 — Attachment Foundation': 'Phase 1 — 附件基础设施',
    'Phase 1 — Signal DM E2EE': 'Phase 1 — Signal DM 端到端加密',
    'Phase 1 — Bot Engine Core': 'Phase 1 — Bot 引擎核心',
    'Phase 1 — Node Bot SDK': 'Phase 1 — Node Bot SDK',
    'Phase 1 — Minimal Base Bots': 'Phase 1 — 最小基础 Bot',
    'Phase 1 — Web Client Shell': 'Phase 1 — Web 客户端外壳',
    'Phase 1 — Electron Shell': 'Phase 1 — Electron 外壳',
    'Phase 1 — Observability & Hardening': 'Phase 1 — 可观测性与加固',
    'Phase 1 — Local Dev, CI & Release': 'Phase 1 — 本地开发、CI 与发布',
    'Research': '技术调研',
    'Frontend Architecture': '前端架构与性能优化',
    'Backend IM & State Machine': 'Node.js 核心 IM 与状态机设计',
    'UI Components & Plugin Protocol': '组件化 UI 与插件生态协议',
    'Bot Engine & Microservices': '异步 Bot 引擎与微服务解耦',
    'Security Defense & E2EE': '低成本防御方案与未来 E2EE 路线',
    'Base Bot Catalog': '基础 Bot 目录',
    'AI Agent Orchestration': 'AI Agent 编排与流式交互设计',
    'Bot SDK': 'Bot SDK',
    'Node.js / TypeScript': 'Node.js / TypeScript',
    'Java': 'Java',
    'Python': 'Python',
    'PHP': 'PHP',
    'Go': 'Go',
    'Rust': 'Rust',
    'AI Context': 'AI 会话上下文',
}
def tr(s):
    if s in MAP: return MAP[s]
    if len(s) < 60 and ' ' in s:
        try:
            from deep_translator import GoogleTranslator
            t = GoogleTranslator(source='en', target='zh-CN')
            r = t.translate(s); MAP[s] = r; return r
        except Exception: pass
    return s
def walk(items):
    for i in items:
        if isinstance(i, dict):
            for k in list(i.keys()):
                nk = tr(k)
                if nk != k: i[nk] = i.pop(k)
                v = i[nk]
                if isinstance(v, list): walk(v)
walk(zh_cfg.get('nav', []))

# Chinese alternate links: same as English (both point to the correct language roots)
zh_cfg.setdefault('extra', {})['alternate'] = [
    {'name': 'English', 'link': path + '/',        'lang': 'en'},
    {'name': '中文',    'link': path + '/zh/',      'lang': 'zh'},
]

with open('mkdocs-zh.yml', 'w', encoding='utf-8') as f:
    yaml.dump(zh_cfg, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
print('     Done.')
"

echo ""
echo "=== 3. Building English site (site/) ==="
mkdocs build -f mkdocs-en.yml --clean

echo ""
echo "=== 4. Building Chinese site (site/zh/) ==="
mkdocs build -f mkdocs-zh.yml --clean

echo ""
echo "=== Done ==="
echo "  English: site/index.html"
echo "  Chinese: site/zh/index.html"
