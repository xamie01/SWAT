import os
import docx
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_ALIGN_VERTICAL
from docx.oxml import parse_xml, OxmlElement
from docx.oxml.ns import nsdecls, qn

def set_cell_background(cell, hex_color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{hex_color}"/>')
    tcPr.append(shd)

def set_cell_margins(cell, top=140, bottom=140, left=200, right=200):
    tcPr = cell._tc.get_or_add_tcPr()
    tcMar = parse_xml(
        f'<w:tcMar {nsdecls("w")}>'
        f'<w:top w:w="{top}" w:type="dxa"/>'
        f'<w:bottom w:w="{bottom}" w:type="dxa"/>'
        f'<w:left w:w="{left}" w:type="dxa"/>'
        f'<w:right w:w="{right}" w:type="dxa"/>'
        f'</w:tcMar>'
    )
    tcPr.append(tcMar)

def set_callout_borders(cell, border_color="0284C7"):
    tcPr = cell._tc.get_or_add_tcPr()
    borders = parse_xml(
        f'<w:tcBorders {nsdecls("w")}>'
        f'<w:top w:val="none"/>'
        f'<w:left w:val="single" w:sz="36" w:space="0" w:color="{border_color}"/>'
        f'<w:bottom w:val="none"/>'
        f'<w:right w:val="none"/>'
        f'</w:tcBorders>'
    )
    tcPr.append(borders)

def set_table_borders(table, border_color="CBD5E1"):
    tblPr = table._tbl.tblPr
    borders = parse_xml(
        f'<w:tblBorders {nsdecls("w")}>'
        f'<w:top w:val="single" w:sz="4" w:space="0" w:color="{border_color}"/>'
        f'<w:bottom w:val="single" w:sz="8" w:space="0" w:color="{border_color}"/>'
        f'<w:insideH w:val="single" w:sz="4" w:space="0" w:color="{border_color}"/>'
        f'<w:insideV w:val="none"/>'
        f'<w:left w:val="none"/>'
        f'<w:right w:val="none"/>'
        f'</w:tblBorders>'
    )
    tblPr.append(borders)

def build_docx(output_paths):
    doc = docx.Document()

    # Section & Margins (0.75 in all around for spacious professional layout)
    section = doc.sections[0]
    section.top_margin = Inches(0.75)
    section.bottom_margin = Inches(0.75)
    section.left_margin = Inches(0.75)
    section.right_margin = Inches(0.75)
    section.page_width = Inches(8.5)
    section.page_height = Inches(11.0)

    # Header & Footer
    header = section.header
    hp = header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    hrun = hp.add_run("Wake Protocol • 20-Post X (Twitter) Build Progress Campaign")
    hrun.font.name = "Segoe UI"
    hrun.font.size = Pt(8.5)
    hrun.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

    footer = section.footer
    fp = footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    frun = fp.add_run("Wake Protocol — Confidential & Proprietary Execution Architecture Guide")
    frun.font.name = "Segoe UI"
    frun.font.size = Pt(8.5)
    frun.font.color.rgb = RGBColor(0x94, 0xA3, 0xB8)

    # Styles setup
    style_normal = doc.styles['Normal']
    style_normal.font.name = 'Segoe UI'
    style_normal.font.size = Pt(10.5)
    style_normal.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)

    # -------------------------------------------------------------
    # COVER / TITLE BLOCK
    # -------------------------------------------------------------
    badge_p = doc.add_paragraph()
    badge_run = badge_p.add_run("COMMUNITY & GROWTH CAMPAIGN • Q4 2026")
    badge_run.font.name = "Segoe UI"
    badge_run.font.size = Pt(9.5)
    badge_run.font.bold = True
    badge_run.font.color.rgb = RGBColor(0x02, 0x84, 0xC7) # Tailwind sky-600
    badge_p.paragraph_format.space_before = Pt(10)
    badge_p.paragraph_format.space_after = Pt(4)

    title_p = doc.add_paragraph()
    title_run = title_p.add_run("Wake Protocol — 20-Post X (Twitter) Build Progress Campaign")
    title_run.font.name = "Segoe UI"
    title_run.font.size = Pt(24)
    title_run.font.bold = True
    title_run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A) # Slate-900
    title_p.paragraph_format.space_after = Pt(8)

    sub_p = doc.add_paragraph()
    sub_run = sub_p.add_run(
        "A staged, high-signal social campaign engineered for Crypto Twitter / X. "
        "It translates the 6 protocol build stages into a compelling narrative arc: "
        "moving from the core thesis, through high-speed line ingestion and non-custodial security, "
        "to live product capabilities, cross-chain execution, and official public onboarding."
    )
    sub_run.font.size = Pt(11)
    sub_run.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
    sub_p.paragraph_format.space_after = Pt(16)

    # Decorative colored divider table
    div_table = doc.add_table(rows=1, cols=1)
    div_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    div_cell = div_table.cell(0, 0)
    set_cell_background(div_cell, "0284C7")
    set_cell_margins(div_cell, top=20, bottom=20, left=0, right=0)
    div_p = div_cell.paragraphs[0]
    div_p.text = ""
    div_p.paragraph_format.space_before = Pt(0)
    div_p.paragraph_format.space_after = Pt(0)

    doc.add_paragraph().paragraph_format.space_after = Pt(8)

    # -------------------------------------------------------------
    # EXECUTIVE SUMMARY & CAMPAIGN SPECIFICATIONS
    # -------------------------------------------------------------
    h1 = doc.add_paragraph()
    h1_run = h1.add_run("1. Campaign Cadence & Specifications")
    h1_run.font.size = Pt(16)
    h1_run.font.bold = True
    h1_run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
    h1.paragraph_format.space_before = Pt(16)
    h1.paragraph_format.space_after = Pt(8)

    spec_table = doc.add_table(rows=5, cols=2)
    spec_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(spec_table, "CBD5E1")

    specs = [
        ("Posting Cadence", "1 post daily, staggered across 3 weeks (5 to 7 posts per week)"),
        ("Strategic Tone", "Builder-centric, high-signal, technically rigorous, anti-vapourware, proof-of-work"),
        ("Primary Target Audience", "DeFi power users, on-chain traders, MEV researchers, protocol developers, & quant copy-traders"),
        ("Supported Chains", "Solana (Raydium/Pump.fun/Jito), Robinhood Chain (Arbitrum L2), Polymarket (ERC-7739 Safe)"),
        ("Visual Proof Assets", "21 verified high-resolution application screenshots attached inline")
    ]

    for idx, (label, val) in enumerate(specs):
        row = spec_table.rows[idx]
        c0, c1 = row.cells[0], row.cells[1]
        c0.width = Inches(2.2)
        c1.width = Inches(4.8)
        set_cell_margins(c0, top=80, bottom=80, left=100, right=100)
        set_cell_margins(c1, top=80, bottom=80, left=100, right=100)
        set_cell_background(c0, "F8FAFC")
        
        p0 = c0.paragraphs[0]
        r0 = p0.add_run(label)
        r0.font.bold = True
        r0.font.size = Pt(9.5)
        r0.font.color.rgb = RGBColor(0x33, 0x41, 0x55)
        
        p1 = c1.paragraphs[0]
        r1 = p1.add_run(val)
        r1.font.size = Pt(9.5)
        r1.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

    doc.add_paragraph().paragraph_format.space_after = Pt(12)

    # Schedule Roadmap Table
    h2_road = doc.add_paragraph()
    h2_road_run = h2_road.add_run("Narrative Arc & Weekly Breakdown")
    h2_road_run.font.size = Pt(13)
    h2_road_run.font.bold = True
    h2_road_run.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)
    h2_road.paragraph_format.space_before = Pt(8)
    h2_road.paragraph_format.space_after = Pt(6)

    road_table = doc.add_table(rows=4, cols=3)
    road_table.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_table_borders(road_table, "CBD5E1")

    # Header row
    hdr = road_table.rows[0]
    for ci, htext in enumerate(["Week & Posts", "Core Theme & Narrative Focus", "Key Deliverables / Proof Points"]):
        cell = hdr.cells[ci]
        set_cell_background(cell, "0F172A")
        set_cell_margins(cell, top=100, bottom=100, left=100, right=100)
        p = cell.paragraphs[0]
        r = p.add_run(htext)
        r.font.bold = True
        r.font.size = Pt(9.5)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)

    weeks_data = [
        ("Week 1\n(Posts 1 – 7)", "The Problem, Thesis & Ingestion Engine", "Manifesto, Postgres BRIN line speed, cross-chain reality, Sybil clusters, Jito MEV bundles, early buyer discovery, daily scorer batch tiers."),
        ("Week 2\n(Posts 8 – 14)", "Non-Custodial Vaults & Risk Architecture", "Keyless non-custodial rule, Solana Anchor PDAs, Robinhood Chain EIP-7702, Polymarket Safe proxies, 50-copier capacity caps, lot-by-lot proportional exits, autonomous stop-loss."),
        ("Week 3\n(Posts 15 – 20)", "Web3 Console, Dynamic SIWE & Official Launch", "Global emergency killswitch, 1-click Web3 wallet connection, dynamic SIWE domain mismatch fix, operator vs trader dual console, USDC subscription tiers, official launch CTA.")
    ]

    for idx, (w_col, t_col, d_col) in enumerate(weeks_data):
        row = road_table.rows[idx + 1]
        c0, c1, c2 = row.cells[0], row.cells[1], row.cells[2]
        c0.width = Inches(1.5)
        c1.width = Inches(2.5)
        c2.width = Inches(3.0)
        for ci, c in enumerate([c0, c1, c2]):
            set_cell_margins(c, top=80, bottom=80, left=100, right=100)
            if idx % 2 == 1:
                set_cell_background(c, "F8FAFC")
        
        p0 = c0.paragraphs[0]
        r0 = p0.add_run(w_col)
        r0.font.bold = True
        r0.font.size = Pt(9.5)
        
        p1 = c1.paragraphs[0]
        r1 = p1.add_run(t_col)
        r1.font.size = Pt(9.5)
        
        p2 = c2.paragraphs[0]
        r2 = p2.add_run(d_col)
        r2.font.size = Pt(9.0)

    doc.add_page_break()

    # -------------------------------------------------------------
    # 20 POST DATA DEFINITION
    # -------------------------------------------------------------
    image_dir = "/root/.gemini/antigravity-cli/brain/9e480172-370b-401d-82a9-e74724464640/images"

    posts = [
        {
            "num": 1,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "The Manifesto / The Gap Between Alpha and Action",
            "phase": "Announcement & Core Thesis",
            "hook": "Most crypto alert channels are graveyards for capital. Here is why.",
            "tweet": (
                "Most Telegram signal bots are graveyards for your capital.\n\n"
                "By the time an alert pings:\n"
                "1. The insider already bought at block 0\n"
                "2. Toxic MEV bots have sandwiched the liquidity\n"
                "3. You buy the top of the candle\n\n"
                "Alerts are passive. What DeFi actually needs is immediate, non-custodial execution.\n\n"
                "Enter Wake Protocol. 🧵👇"
            ),
            "thread": (
                "We spent the last few weeks engineering Wake Protocol from the bare metal up:\n"
                "• Multi-chain ingestion across Solana, Robinhood Chain, & Polymarket\n"
                "• Cluster intelligence that flags coordinated syndicates\n"
                "• Zero-custody execution rails via Anchor PDAs & EIP-7702\n\n"
                "Here is how we built it. 🛠️"
            ),
            "images": [
                {
                    "filename": "post01_wake_manifesto.png",
                    "caption": "Figure 1: Wake Protocol Manifesto & Execution Thesis",
                    "description": "Visual proof asset showcasing the core Wake Protocol thesis: moving beyond passive alert fatigue into automated non-custodial execution."
                }
            ]
        },
        {
            "num": 2,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "Solving the Line-Speed Problem (Postgres BRIN + Redis Streams)",
            "phase": "Infrastructure Deep Dive",
            "hook": "How do you index 100M+ transactions without setting your database on fire?",
            "tweet": (
                "How do you query 100,000,000+ on-chain transactions in milliseconds without choking your DB?\n\n"
                "Standard B-Trees inflate to 40GB+ and eat all your RAM.\n\n"
                "For Wake Protocol, we deployed PostgreSQL BRIN (Block Range Indexing) on block timestamps alongside Redis 7.4 streams.\n\n"
                "The result:\n"
                "⚡ 98% index storage reduction\n"
                "⚡ Sub-10ms range scans across months of mempool data\n"
                "⚡ Zero worker starvation under peak Solana block surges\n\n"
                "Build for scale before you need it."
            ),
            "images": [
                {
                    "filename": "post02_postgres_brin_scale.png",
                    "caption": "Figure 2: PostgreSQL BRIN Query Benchmark & Line Speed Architecture",
                    "description": "Telemetry visual demonstrating sub-10ms query execution across 100M+ indexed transactions utilizing PostgreSQL BRIN indexes."
                }
            ]
        },
        {
            "num": 3,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "The Cross-Chain Reality (Solana, EVM, Polymarket)",
            "phase": "Architecture & Venue Unification",
            "hook": "Alpha doesn't stay on one chain. Your execution engine shouldn't either.",
            "tweet": (
                "Alpha in 2026 isn't confined to a single ecosystem:\n\n"
                "• Solana: High-frequency mempool velocity & sniper clusters\n"
                "• Robinhood Chain (Arbitrum L2): Retail liquidity & sponsored execution\n"
                "• Polymarket: Global macro odds & prediction market CLOBs\n\n"
                "Most tools force you to run 3 separate dashboards.\n\n"
                "Wake Protocol unifies all three into a single multi-chain execution engine with unified telemetry."
            ),
            "images": [
                {
                    "filename": "post03_multichain_ingestion.png",
                    "caption": "Figure 3: Multi-Chain Unified Architecture & Live Ingestion Streams",
                    "description": "Architecture topology displaying parallel ingestion workers pulling real-time blocks from Solana, Arbitrum/Robinhood Chain, and Polygon Polymarket."
                }
            ]
        },
        {
            "num": 4,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "The Sybil Trap — Individual Wallets vs. Behavioral Clusters",
            "phase": "Intelligence Layer & Anti-Sybil Defense",
            "hook": "Tracking single 'smart money' wallets is dead. Syndicates use 30 burner wallets.",
            "tweet": (
                "Tracking a single \"smart money\" wallet address is a trap.\n\n"
                "Top market makers and insider syndicates never trade from one address:\n"
                "• They split capital across 20–50 fresh wallets\n"
                "• They buy within the same 3-second block window\n"
                "• They funnel profits through common funding hubs\n\n"
                "Wake Protocol doesn't track addresses. It clusters behaviors.\n\n"
                "Our clustering engine maps temporal correlation, shared funding trees, and simultaneous routing. You track the syndicate, not the sockpuppet."
            ),
            "images": [
                {
                    "filename": "post04_cluster_intelligence.png",
                    "caption": "Figure 4: Sybil Defense & Cluster Intelligence Console",
                    "description": "Cluster graph visual mapping co-funding trees and temporal block correlations to de-anonymize coordinated wallet rings."
                }
            ]
        },
        {
            "num": 5,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "Defeating Toxic Sandwich Attacks on Solana (Jito MEV Bundles)",
            "phase": "Execution Layer & MEV Protection",
            "hook": "Public mempool swaps on Solana are an open donation to MEV bots.",
            "tweet": (
                "If your copy-trading bot sends standard RPC transactions on Solana, you are getting sandwiched. Full stop.\n\n"
                "Wake Protocol bypasses the public mempool entirely:\n"
                "🛡️ Direct Jito Block Engine bundle submission\n"
                "🛡️ Dynamic tip auctioning based on block congestion\n"
                "🛡️ Atomic guarantee: the trade confirms in the bundle or not at all\n\n"
                "No front-running. No back-running. No toxic slippage."
            ),
            "images": [
                {
                    "filename": "post05_jito_bundles_execution.png",
                    "caption": "Figure 5: Jito MEV Bundles & Slippage Protection Settings",
                    "description": "Direct integration with the Jito Block Engine showing bundle tip configuration and 0% sandwich slippage guarantees."
                }
            ]
        },
        {
            "num": 6,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "Early Buyer Discovery (The First 10 Minutes)",
            "phase": "Ingestion & Discovery Daemon",
            "hook": "Finding the alpha before Twitter finds out.",
            "tweet": (
                "Where do high-conviction wallets come from?\n\n"
                "Our discovery daemon monitors Raydium, Pump.fun, and Uniswap pool creation events in real time.\n\n"
                "When a fresh pool deploys:\n"
                "1. Filters for early buyers entering within the first 10 minutes\n"
                "2. Requires >0.5 SOL minimum skin-in-the-game (filters spam dust)\n"
                "3. Grades their historical wallet win rate & profit retention\n\n"
                "The engine continually seeds itself with newly discovered elite traders."
            ),
            "images": [
                {
                    "filename": "post06_early_buyer_discovery.png",
                    "caption": "Figure 6: Early Buyer Discovery Stream & Live Signals",
                    "description": "Real-time feed showing automated detection of high-conviction wallet entries within the initial 10-minute liquidity deployment window."
                }
            ]
        },
        {
            "num": 7,
            "week": "Week 1: The Problem & Ingestion Engine",
            "title": "Daily Scorer Batch & The 3 Wallet Tiers",
            "phase": "Intelligence & Quant Grading",
            "hook": "Past luck ≠ repeatable alpha. How we mathematically filter the noise.",
            "tweet": (
                "A trader who made 100x on one meme coin isn't a master trader. They got lucky.\n\n"
                "Every night at 02:00 UTC, Wake Protocol runs an automated scoring batch over every tracked wallet:\n"
                "• Realized ROI vs. Unrealized Drawdown\n"
                "• Sharpe & Expectancy metrics\n"
                "• Win rate across a minimum of 20 closed lots\n\n"
                "Wallets are dynamically tiered:\n"
                "🟢 Elite: High win-rate, disciplined sizing\n"
                "🟡 Pro: Consistent momentum\n"
                "⚪ Tracked: Under continuous telemetry\n\n"
                "Follow only verifiable performance."
            ),
            "images": [
                {
                    "filename": "post07_daily_scorer_tiers.png",
                    "caption": "Figure 7: Daily Scored Wallets & Tier Ranking Matrix",
                    "description": "Daily quant ranking console displaying Sharpe ratio, expectancy score, and automatic tier categorization (Elite, Pro, Tracked)."
                }
            ]
        },
        {
            "num": 8,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "The Non-Custodial Golden Rule",
            "phase": "Custody Architecture & Threat Modeling",
            "hook": "'Give us your private keys so we can copy-trade for you' — Never again.",
            "tweet": (
                "The number one question we get:\n"
                "\"Do I have to export my private key to use Wake Protocol?\"\n\n"
                "The answer is absolute: NEVER.\n\n"
                "Exporting your private keys to a third-party server is an architectural failure waiting for an exploit.\n\n"
                "Wake Protocol uses 100% keyless, non-custodial custody rails:\n"
                "• Solana: Isolated Anchor PDAs\n"
                "• EVM: EIP-7702 Session Keys\n"
                "• Polymarket: Isolated Safe Proxies\n\n"
                "Your capital never leaves your cryptographic control."
            ),
            "images": [
                {
                    "filename": "post08_zero_custody_vault.png",
                    "caption": "Figure 8: Zero-Custody Multi-Chain Vault Overview",
                    "description": "Multi-chain user vault interface highlighting cryptographic keyless isolation across Solana, EVM, and Polymarket."
                }
            ]
        },
        {
            "num": 9,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "Under the Hood: Solana Anchor Keyless PDA",
            "phase": "Cryptographic Smart Contract Engineering",
            "hook": "How do you execute trades on Solana without the server having your keys?",
            "tweet": (
                "How does Wake Protocol trade on Solana without holding your keys?\n\n"
                "Anchor Program Derived Addresses (PDAs):\n"
                "seeds = [b\"wake_vault\", user_public_key]\n"
                "program_id = 6t6dRetG3H...\n\n"
                "Properties:\n"
                "1. The PDA has NO private key on earth.\n"
                "2. Only the smart contract can execute authorized swaps within pre-set slippage caps.\n"
                "3. You hold the sole master authority: closing the vault returns all rent lamports and assets directly to your wallet.\n\n"
                "Mathematical security > Promises."
            ),
            "images": [
                {
                    "filename": "post09_solana_anchor_pda.png",
                    "caption": "Figure 9: Solana Keyless Anchor Program Derived Address (PDA)",
                    "description": "Smart contract PDA creation card confirming mathematical rent-exempt vault deployment on Solana."
                }
            ]
        },
        {
            "num": 10,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "Robinhood Chain & EIP-7702 Account Abstraction",
            "phase": "EVM Engineering & Gas Sponsorship",
            "hook": "Gasless copy-trading on EVM using Ethereum's cutting-edge standard.",
            "tweet": (
                "EIP-7702 changes the game for EVM execution.\n\n"
                "Instead of deploying heavy smart contract wallets, your existing EOA temporarily delegates execution rights to an ERC-4337 smart account:\n\n"
                "✨ 30-Day Scoped Session: Only allowed to interact with vetted trading pairs\n"
                "✨ 100% Gas Sponsorship: Wake Paymaster covers gas (no need to bridge gas tokens)\n"
                "✨ Revoke Anytime: 1-click on-chain revocation kills the session instantly\n\n"
                "No wallet migrations. Pure native Web3 UX."
            ),
            "images": [
                {
                    "filename": "post10_robinhood_eip7702.png",
                    "caption": "Figure 10: Robinhood Chain EIP-7702 Session & Gas Sponsorship",
                    "description": "Robinhood Chain EIP-7702 scoped delegation card showing gas sponsorship status and 1-click instant session revocation."
                }
            ]
        },
        {
            "num": 11,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "Polymarket Safe Deposit Proxies",
            "phase": "Prediction Market Execution",
            "hook": "Copy-trading prediction markets without custodial risk.",
            "tweet": (
                "Polymarket is the world's largest prediction exchange, but it doesn't support scoped signers out of the box.\n\n"
                "Our solution: Isolated ERC-7739 Safe Deposit Proxies on Polygon.\n\n"
                "• You deposit USDC into your dedicated Safe Proxy address\n"
                "• Wake's CLOB executor submits matched limit orders\n"
                "• Capital withdrawals are strictly whitelisted to your verified linked wallet\n\n"
                "Venue-isolated liquidity with zero risk of cross-account contamination."
            ),
            "images": [
                {
                    "filename": "post11_polymarket_safe_proxy.png",
                    "caption": "Figure 11: Polymarket Safe Deposit Proxy Card",
                    "description": "Isolated Safe Proxy card with dedicated Polygon deposit address and whitelisted return destination verification."
                }
            ]
        },
        {
            "num": 12,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "The Capacity Cap Problem (Why 50 Followers is the Limit)",
            "phase": "Market Microstructure & Fairness",
            "hook": "Why popular copy-trading platforms silently front-run their own users.",
            "tweet": (
                "Ever wonder why public copy-trading platforms have terrible returns?\n\n"
                "When 2,000 people copy the same whale:\n"
                "1. The whale buys at $1.00\n"
                "2. Follower #1 buys at $1.02\n"
                "3. Follower #2000 buys at $2.10 (pumping the price for the whale)\n"
                "4. The whale dumps at $2.00 into their own followers' bids.\n\n"
                "Wake Protocol enforces a hard cap: MAX 50 COPIERS per master wallet.\n\n"
                "We protect follower liquidity against pool depletion and slippage degradation."
            ),
            "images": [
                {
                    "filename": "post12_capacity_caps_50.png",
                    "caption": "Figure 12: Capacity Cap & Master Fleet Telemetry",
                    "description": "Fleet monitor displaying strict 50-follower capacity enforcement per master wallet to safeguard follower pricing."
                }
            ]
        },
        {
            "num": 13,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "Lot-by-Lot Proportional Exits",
            "phase": "Trade Execution Logic & Unwinding",
            "hook": "What happens when a master wallet only sells half their position?",
            "tweet": (
                "Copy-trading isn't binary. Real whales scale out:\n"
                "• Sell 25% at 2x\n"
                "• Sell 35% on momentum break\n"
                "• Leave 40% as a moonbag\n\n"
                "How does Wake Protocol mirror this? Lot-by-Lot Attribution.\n\n"
                "When the master sells 35%, the engine computes your specific entry lots and proportionally unwinds 35% of your position.\n\n"
                "No stranded dust tokens. Exact mathematical attribution."
            ),
            "images": [
                {
                    "filename": "post13_lot_proportional_exits.png",
                    "caption": "Figure 13: Lot-by-Lot Proportional Attribution & Positions View",
                    "description": "Trader positions dashboard showing real-time lot attribution and fractional tranche execution mirroring master exits."
                }
            ]
        },
        {
            "num": 14,
            "week": "Week 2: Non-Custodial Vaults & Risk Architecture",
            "title": "Autonomous Stop-Loss & Circuit Breakers",
            "phase": "Capital Preservation & Risk Limits",
            "hook": "What if the whale gets rugged while sleeping? You don't go down with them.",
            "tweet": (
                "What happens if the master wallet you copy gets rugged, falls asleep, or makes a catastrophic mistake?\n\n"
                "You don't go down with them.\n\n"
                "Wake Protocol features an off-chain Autonomous Stop-Loss Engine:\n"
                "🛑 Per-User Drawdown Cap: If a position drops >X%, auto-liquidate to USDC\n"
                "🛑 Global Circuit Breaker: Halts copying if venue volatility exceeds safety thresholds\n"
                "🛑 Slippage Guard: Orders abort if pool liquidity drops below execution minimums\n\n"
                "Protecting your downside is rule #1."
            ),
            "images": [
                {
                    "filename": "post14_autonomous_stop_loss.png",
                    "caption": "Figure 14: Autonomous Stop-Loss & Circuit Breaker Settings",
                    "description": "Risk parameter console displaying custom per-user stop-loss thresholds and venue circuit breaker triggers."
                }
            ]
        },
        {
            "num": 15,
            "week": "Week 3: Web3 Console, Dynamic SIWE & Launch",
            "title": "The Global Emergency Off Switch",
            "phase": "System Reliability & Fail-Safe Rails",
            "hook": "The red button every institutional trading platform needs.",
            "tweet": (
                "In high-frequency trading, your emergency shutoff must be absolute.\n\n"
                "If an operator or trader triggers EMERGENCY OFF in Wake Protocol:\n"
                "🚨 Broadcasts across Redis Pub/Sub in <2ms\n"
                "🚨 Cancels all pending in-flight Jito and EVM transactions\n"
                "🚨 Halts order dispatchers across all 3 venues instantly\n"
                "🚨 Puts all follower accounts into capital preservation mode\n\n"
                "Zero hesitation. Safety first."
            ),
            "images": [
                {
                    "filename": "post15_emergency_killswitch.png",
                    "caption": "Figure 15: Emergency Kill-Switch & Real-Time Microservice Logs",
                    "description": "Operator emergency killswitch dashboard showing immediate sub-2ms pub/sub broadcast and complete order cancellation."
                }
            ]
        },
        {
            "num": 16,
            "week": "Week 3: Web3 Console, Dynamic SIWE & Launch",
            "title": "1-Click Web3 Wallet Integration (No Copy-Pasting)",
            "phase": "Web3 UX & Wallet Connectivity",
            "hook": "Copy-pasting 0x and Solana addresses into text boxes is archaic.",
            "tweet": (
                "Web3 UX should feel like Web3, not an Excel spreadsheet from 2004.\n\n"
                "We completely redesigned the Wake Protocol custody vault:\n"
                "⚡ 1-Click Phantom, Solflare, & Backpack integration (Solana)\n"
                "⚡ 1-Click MetaMask, Rabby, & Coinbase Wallet integration (EVM)\n"
                "⚡ Automatic Polygon network switching for Polymarket\n"
                "⚡ Zero address pasting: instant cryptographic signature verification\n\n"
                "Connect, sign once, and your execution vault is live."
            ),
            "images": [
                {
                    "filename": "post16_oneclick_wallet_connect.png",
                    "caption": "Figure 16: 1-Click Multi-Chain Wallet Connection Bar",
                    "description": "Native Web3 wallet integration bar offering 1-click Phantom, Solflare, Rabby, and MetaMask cryptographic connectivity."
                }
            ]
        },
        {
            "num": 17,
            "week": "Week 3: Web3 Console, Dynamic SIWE & Launch",
            "title": "Fixing the 'Domain Mismatch' Security Bug",
            "phase": "Cryptographic Engineering & SIWE / SIWS",
            "hook": "Ever had MetaMask or Phantom flash a scary 'Deceptive Request' warning? Here is how we fixed it.",
            "tweet": (
                "Ever had MetaMask warn you with a red screen:\n"
                "\"Deceptive Request: Domain mismatch\"?\n\n"
                "It happens when the backend hardcodes an auth domain (e.g., localhost) in the SIWE/SIWS challenge message that doesn't match the user's active tab.\n\n"
                "We engineered dynamic SIWE/SIWS binding:\n"
                "• Challenges dynamically match the caller's origin & host\n"
                "• Atomically consumed in Redis via GETDEL (zero replay attacks)\n"
                "• Smooth, warning-free signature popup in Phantom and MetaMask\n\n"
                "Security without breaking user trust."
            ),
            "images": [
                {
                    "filename": "post17_dynamic_siwe_security.png",
                    "caption": "Figure 17: Dynamic SIWE / SIWS Challenge Dialog",
                    "description": "Warning-free native wallet signature request authenticated with dynamic origin-host binding and atomic single-use nonce consumption."
                }
            ]
        },
        {
            "num": 18,
            "week": "Week 3: Web3 Console, Dynamic SIWE & Launch",
            "title": "Operator Matrix vs. Trader Console",
            "phase": "Product Architecture & Dual Role UX",
            "hook": "One protocol. Two purpose-built command centers.",
            "tweet": (
                "Wake Protocol is built with role-adaptive command centers:\n\n"
                "👨‍💻 Operator Console:\n"
                "• Fleet-wide portfolio & AUM telemetry\n"
                "• Systemic token concentration heatmaps\n"
                "• Live streaming microservice log terminals\n"
                "• Direct cluster scoring & wallet backfilling\n\n"
                "📊 Trader Console:\n"
                "• Non-custodial liquidity vault\n"
                "• Real-time copy execution feed\n"
                "• Granular slippage & position sizing limits\n"
                "• 2FA email security for withdrawals\n\n"
                "Purpose-built interfaces for both operators and followers."
            ),
            "images": [
                {
                    "filename": "post18_operator_matrix.png",
                    "caption": "Figure 18a: Operator Trading Matrix & Fleet AUM Overview",
                    "description": "Institutional operator view with fleet-level AUM metrics, liquidity distribution, and streaming node logs."
                },
                {
                    "filename": "post18_trader_dashboard.png",
                    "caption": "Figure 18b: Trader Non-Custodial Console & Live Execution Feed",
                    "description": "End-user trader console showing active copy slots, individual lot performance, and zero-custody wallet balances."
                }
            ]
        },
        {
            "num": 19,
            "week": "Week 3: Web3 Console, Dynamic SIWE & Launch",
            "title": "Subscription Tiers & Real Crypto Billing",
            "phase": "Monetization & Commercials",
            "hook": "No credit cards. No KYC. Native USDC crypto billing.",
            "tweet": (
                "Software subscriptions shouldn't require Stripe forms or bank accounts.\n\n"
                "Wake Protocol runs on native on-chain USDC subscriptions:\n"
                "🔹 Starter: Free view-only signals and discovery\n"
                "🔹 Operator ($99/mo): 5 copy slots, 50 sponsored ops/day, priority execution\n"
                "🔹 Ultra ($499/mo): 50 copy slots, unlimited sponsored ops, private Jito lanes\n"
                "🔹 Lifetime ($4,999): Permanent institutional access\n\n"
                "Instant on-chain verification. Zero chargebacks."
            ),
            "images": [
                {
                    "filename": "post19_usdc_pricing_tiers.png",
                    "caption": "Figure 19: USDC Subscription Pricing Tiers & On-Chain Billing",
                    "description": "Live pricing tier matrix detailing Starter, Operator ($99), Ultra ($499), and Lifetime tiers paid directly via USDC."
                }
            ]
        },
        {
            "num": 20,
            "week": "Week 3: Web3 Console, Dynamic SIWE & Launch",
            "title": "The Official Launch / Early Access Invitation",
            "phase": "Official Launch & Public Call to Action",
            "hook": "Cross-chain intelligence that acts. We are live.",
            "tweet": (
                "The wait is over. Wake Protocol is live.\n\n"
                "From real-time mempool clustering to keyless non-custodial copy-trading across Solana, Robinhood Chain, and Polymarket:\n\n"
                "We built the bridge between detecting alpha and capturing it.\n\n"
                "👉 Early Access is now open: [LINK]\n"
                "👉 Read our technical documentation: [LINK]\n\n"
                "Stop watching alerts. Start executing. 🌊⚡"
            ),
            "images": [
                {
                    "filename": "post20_official_launch.png",
                    "caption": "Figure 20: Wake Protocol Official Launch Hero",
                    "description": "Official launch visual inviting DeFi power users to onboard into keyless cross-chain copy execution."
                }
            ]
        }
    ]

    current_week = None

    for post in posts:
        # Check if week heading should be added
        if post["week"] != current_week:
            current_week = post["week"]
            wh = doc.add_paragraph()
            wh_run = wh.add_run(current_week.upper())
            wh_run.font.size = Pt(15)
            wh_run.font.bold = True
            wh_run.font.color.rgb = RGBColor(0x02, 0x84, 0xC7)
            wh.paragraph_format.space_before = Pt(20)
            wh.paragraph_format.space_after = Pt(8)

        # Post title heading
        ph = doc.add_paragraph()
        ph_run = ph.add_run(f"Post {post['num']:02d}: {post['title']}")
        ph_run.font.size = Pt(13)
        ph_run.font.bold = True
        ph_run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
        ph.paragraph_format.space_before = Pt(12)
        ph.paragraph_format.space_after = Pt(6)

        # Metadata pills / table
        meta_table = doc.add_table(rows=2, cols=2)
        meta_table.alignment = WD_TABLE_ALIGNMENT.CENTER
        set_table_borders(meta_table, "E2E8F0")

        r0 = meta_table.rows[0]
        r0.cells[0].width = Inches(1.5)
        r0.cells[1].width = Inches(5.5)
        set_cell_background(r0.cells[0], "F1F5F9")
        set_cell_margins(r0.cells[0], top=40, bottom=40, left=80, right=80)
        set_cell_margins(r0.cells[1], top=40, bottom=40, left=80, right=80)
        p = r0.cells[0].paragraphs[0]
        pr = p.add_run("Campaign Phase")
        pr.font.bold = True
        pr.font.size = Pt(8.5)
        pr.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
        p1 = r0.cells[1].paragraphs[0]
        p1r = p1.add_run(post["phase"])
        p1r.font.size = Pt(8.5)
        p1r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

        r1 = meta_table.rows[1]
        r1.cells[0].width = Inches(1.5)
        r1.cells[1].width = Inches(5.5)
        set_cell_background(r1.cells[0], "F1F5F9")
        set_cell_margins(r1.cells[0], top=40, bottom=40, left=80, right=80)
        set_cell_margins(r1.cells[1], top=40, bottom=40, left=80, right=80)
        p = r1.cells[0].paragraphs[0]
        pr = p.add_run("Hook / Premise")
        pr.font.bold = True
        pr.font.size = Pt(8.5)
        pr.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
        p1 = r1.cells[1].paragraphs[0]
        p1r = p1.add_run(post["hook"])
        p1r.font.size = Pt(8.5)
        p1r.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

        # Callout block for Tweet copy
        tbl = doc.add_table(rows=1, cols=1)
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        cell = tbl.cell(0, 0)
        set_cell_background(cell, "F8FAFC")
        set_cell_margins(cell, top=140, bottom=140, left=180, right=180)
        set_callout_borders(cell, "0284C7")

        label_p = cell.paragraphs[0]
        label_r = label_p.add_run("TWEET COPY (Primary Post)")
        label_r.font.name = "Segoe UI"
        label_r.font.bold = True
        label_r.font.size = Pt(8.5)
        label_r.font.color.rgb = RGBColor(0x02, 0x84, 0xC7)
        label_p.paragraph_format.space_after = Pt(6)

        for line in post["tweet"].split("\n"):
            p = cell.add_paragraph()
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.line_spacing = 1.15
            run = p.add_run(line)
            run.font.name = "Segoe UI"
            run.font.size = Pt(10)
            run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)

        # Optional follow-up thread block
        if "thread" in post:
            th_tbl = doc.add_table(rows=1, cols=1)
            th_tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
            th_cell = th_tbl.cell(0, 0)
            set_cell_background(th_cell, "F1F5F9")
            set_cell_margins(th_cell, top=120, bottom=120, left=180, right=180)
            set_callout_borders(th_cell, "64748B")

            th_label_p = th_cell.paragraphs[0]
            th_label_r = th_label_p.add_run("FOLLOW-UP THREAD TWEET (Reply 1/1)")
            th_label_r.font.name = "Segoe UI"
            th_label_r.font.bold = True
            th_label_r.font.size = Pt(8.5)
            th_label_r.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
            th_label_p.paragraph_format.space_after = Pt(4)

            for line in post["thread"].split("\n"):
                p = th_cell.add_paragraph()
                p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.space_before = Pt(0)
                p.paragraph_format.line_spacing = 1.15
                run = p.add_run(line)
                run.font.name = "Segoe UI"
                run.font.size = Pt(9.5)
                run.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)

        # Embedded Images
        for img_info in post["images"]:
            img_path = os.path.join(image_dir, img_info["filename"])
            if os.path.exists(img_path):
                img_p = doc.add_paragraph()
                img_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                img_p.paragraph_format.space_before = Pt(10)
                img_p.paragraph_format.space_after = Pt(4)
                
                # Add picture scaled to 6.2 inches width (fits 7.0 in usable width cleanly)
                run_pic = img_p.add_run()
                run_pic.add_picture(img_path, width=Inches(6.2))

                # Caption
                cap_p = doc.add_paragraph()
                cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                cap_p.paragraph_format.space_before = Pt(2)
                cap_p.paragraph_format.space_after = Pt(4)
                cap_run = cap_p.add_run(img_info["caption"])
                cap_run.font.name = "Segoe UI"
                cap_run.font.size = Pt(9.0)
                cap_run.font.bold = True
                cap_run.font.color.rgb = RGBColor(0x33, 0x41, 0x55)

                # Asset description
                desc_p = doc.add_paragraph()
                desc_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                desc_p.paragraph_format.space_before = Pt(0)
                desc_p.paragraph_format.space_after = Pt(14)
                desc_run = desc_p.add_run(img_info["description"])
                desc_run.font.name = "Segoe UI"
                desc_run.font.size = Pt(8.5)
                desc_run.font.italic = True
                desc_run.font.color.rgb = RGBColor(0x64, 0x74, 0x8B)

        # Post divider line
        post_div = doc.add_paragraph()
        post_div.paragraph_format.space_before = Pt(8)
        post_div.paragraph_format.space_after = Pt(16)
        div_run = post_div.add_run("—" * 52)
        div_run.font.color.rgb = RGBColor(0xCB, 0xD5, 0xE1)
        post_div.alignment = WD_ALIGN_PARAGRAPH.CENTER

    # -------------------------------------------------------------
    # APPENDIX: BEST PRACTICES & CT EXECUTION PLAYBOOK
    # -------------------------------------------------------------
    doc.add_page_break()

    app_h = doc.add_paragraph()
    app_h_run = app_h.add_run("Appendix: Crypto Twitter Execution & Engagement Playbook")
    app_h_run.font.size = Pt(16)
    app_h_run.font.bold = True
    app_h_run.font.color.rgb = RGBColor(0x0F, 0x17, 0x2A)
    app_h.paragraph_format.space_before = Pt(10)
    app_h.paragraph_format.space_after = Pt(10)

    playbook_points = [
        ("Optimal Posting Windows", "Crypto Twitter peaks between 13:00 UTC and 17:00 UTC (9:00 AM – 1:00 PM EST). This aligns US East Coast morning waking hours with European afternoon peak liquidity. Avoid late Friday nights and low-volume Sunday mornings."),
        ("Media Asset Formatting", "All attached images are pre-rendered at high-resolution 16:9 ratio and dark-mode styling. Always upload the raw PNG file without re-compression to maintain font readability on mobile feeds."),
        ("Engagement Protocol", "For the first 60 minutes after every post, actively reply to all technical comments. In Crypto Twitter, algorithmic distribution favors tweets with early multi-turn author replies."),
        ("Quote Retweet Strategy", "Tag recognized Solana and Arbitrum ecosystem figures, MEV researchers, and infrastructure providers when sharing relevant technical milestones (e.g., Jito Labs for Post 5, Arbitrum / Robinhood for Post 10, Polymarket builders for Post 11)."),
        ("Community Conversion", "Every thread links to the official documentation and the live app gateway. Ensure the Discord and Telegram communities have automated webhooks alerting members whenever a campaign tweet goes live.")
    ]

    for title, desc in playbook_points:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(4)
        r_t = p.add_run(f"• {title}: ")
        r_t.font.bold = True
        r_t.font.size = Pt(10)
        r_t.font.color.rgb = RGBColor(0x02, 0x84, 0xC7)
        r_d = p.add_run(desc)
        r_d.font.size = Pt(9.5)
        r_d.font.color.rgb = RGBColor(0x33, 0x41, 0x55)

    # Save to both target locations
    for out_path in output_paths:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        doc.save(out_path)
        print(f"Successfully generated: {out_path} ({os.path.getsize(out_path)} bytes)")

if __name__ == "__main__":
    targets = [
        "/root/SWAT/docs/WAKE_PROTOCOL_X_CAMPAIGN.docx",
        "/root/.gemini/antigravity-cli/brain/9e480172-370b-401d-82a9-e74724464640/wake_protocol_x_content_campaign.docx"
    ]
    build_docx(targets)
