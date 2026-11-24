"""Renders README screenshots from media/pet.html with headless Chrome.

Usage: python3 docs/make-screenshots.py   (macOS, Google Chrome installed)
Writes docs/screenshots/*.png.
"""
import json, os, re, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "screenshots")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DARK = """:root{--vscode-font-family:-apple-system,system-ui,sans-serif;--vscode-foreground:#cccccc;--vscode-editorWidget-background:#252526;
--vscode-editorWidget-border:#454545;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;
--vscode-button-secondaryForeground:#ccc;--vscode-textLink-foreground:#3794ff}body{background:#181818}.bubble{transition:none!important}"""

page = open(os.path.join(ROOT, "media", "pet.html")).read()
panel = (page.replace("{{nonce}}", "x").replace("{{csp}}", "")
         .replace('<meta http-equiv="Content-Security-Policy"', '<meta data-x')
         .replace("<head>", "<head><script>window.acquireVsCodeApi=()=>({postMessage(){}});</script><style>" + DARK + "</style>", 1))
sprites = json.loads(re.search(r"const SPRITES = (\{.*?\});\n", page).group(1))

def stats(intention="", focus="18m", today="2h 05m", breaks=3, on_break=False, left=0):
    return {"type": "stats", "focus": focus, "today": today, "breaks": breaks, "onBreak": on_break, "breakLeft": left, "intention": intention}

# name -> messages posted to the panel
STATES = {
    "start": [stats()],
    "intention": [stats("Fix the login bug")],
    "breathing": [stats("Fix the login bug"), {"type": "breathe", "cycles": 4}],
    "break": [stats("Fix the login bug", focus="0m", on_break=True, left=263),
              {"type": "say", "text": "Close your eyes and listen: name three sounds you can hear. 👂"}],
    "checkin": [stats("Fix the login bug"), {"type": "say", "text": "Welcome back. Still on: “Fix the login bug”?"}],
    "claude": [stats("Write tests for the parser"),
               {"type": "say", "text": "Something's working on your code. While it does, try one slow breath: in for 4, out for 6. 🍃"}],
}

def frame(title, src, w, h):
    return (f'<div class="win"><div class="hd"><span>⌄</span> {title}</div>'
            f'<iframe src="{src}" style="width:{w}px;height:{h}px;border:0;display:block"></iframe></div>')

STYLE = """<style>body{margin:0;background:#0d0d0d;font:12px -apple-system,system-ui,sans-serif;color:#ccc}
.wrap{display:flex;gap:18px;padding:18px;flex-wrap:wrap}.win{background:#181818;border:1px solid #2b2b2b;border-radius:8px;overflow:hidden}
.hd{font-weight:600;font-size:11px;padding:6px 10px;border-bottom:1px solid #2b2b2b;color:#bbb}.cap{text-align:center;margin-top:6px;color:#888}
.cell{display:flex;flex-direction:column}</style>"""

def shoot(html_name, png_name, w, h, budget=3000):
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                    "--force-device-scale-factor=2", f"--window-size={w},{h}", f"--virtual-time-budget={budget}",
                    f"--screenshot={os.path.join(OUT, png_name)}", "file://" + os.path.join(tmp, html_name)],
                   check=True, stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

os.makedirs(OUT, exist_ok=True)
tmp = tempfile.mkdtemp()
for name, msgs in STATES.items():
    posts = "".join(f"postMessage({json.dumps(m, ensure_ascii=False)},'*');" for m in msgs if m["type"] != "say")
    posts += "".join(f"setTimeout(()=>postMessage({json.dumps(m, ensure_ascii=False)},'*'),8500);" for m in msgs if m["type"] == "say")
    script = f"<script>setTimeout(()=>{{postMessage({{type:'pet',id:'sprout'}},'*');{posts}}},50);</script></body>"
    open(os.path.join(tmp, name + ".html"), "w").write(panel.replace("</body>", script))

# 1. Compact panel states (the default sidebar size)
cells = [("start", "Ready: set an intention"), ("intention", "Focusing on an intention"), ("breathing", "Box breathing"),
         ("break", "On a break, with a small idea"), ("checkin", "Back from a break: check in"), ("claude", "While Claude works: breathe")]
body = "".join(f'<div class="cell">{frame("SPRIG 🌱", n + ".html", 249, 137)}<div class="cap">{c}</div></div>' for n, c in cells)
open(os.path.join(tmp, "states.html"), "w").write(f"<html><head>{STYLE}</head><body><div class='wrap' style='width:789px'>{body}</div></body></html>")
shoot("states.html", "panel-states.png", 825, 420, budget=9500)

# 2. Taller panel (full layout)
open(os.path.join(tmp, "tall.html"), "w").write(f"<html><head>{STYLE}</head><body><div class='wrap'>{frame('SPRIG 🌱', 'intention.html', 260, 330)}</div></body></html>")
shoot("tall.html", "panel-tall.png", 298, 386)

# 3. Pet gallery
gallery = f"""<html><head>{STYLE}<style>.g{{display:grid;grid-template-columns:repeat(6,120px);gap:10px;padding:18px}}
.p{{background:#181818;border:1px solid #2b2b2b;border-radius:8px;padding:10px 0 8px;text-align:center}}canvas{{image-rendering:pixelated}}</style></head>
<body><div class="g" id="g"></div><script>const S={json.dumps(sprites, ensure_ascii=False)};
const order=['sprout','clawd',...Object.keys(S).filter(k=>k!=='sprout'&&k!=='clawd')];
for(const k of order){{const s=S[k],d=document.createElement('div');d.className='p';const c=document.createElement('canvas');c.width=c.height=80;
const x=c.getContext('2d');s.grid.forEach((r,i)=>[...r].forEach((ch,j)=>{{if(ch!=='.'){{x.fillStyle=s.pal[ch];x.fillRect(j*5,i*5,5,5);}}}}));
d.appendChild(c);const n=document.createElement('div');n.textContent=s.name;n.style.marginTop='6px';d.appendChild(n);g.appendChild(d);}}</script></body></html>"""
open(os.path.join(tmp, "gallery.html"), "w").write(gallery)
shoot("gallery.html", "pets.png", 6 * 130 + 26, 4 * 140 + 30)
print("wrote", sorted(os.listdir(OUT)))
