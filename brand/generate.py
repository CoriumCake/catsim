#!/usr/bin/env python3
"""Generates the CatSim logo SVGs in this folder (no dependencies). Run: python3 brand/generate.py"""
import math, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
def f(v): return f"{v:.2f}".rstrip('0').rstrip('.')
def P(pts): return "M"+" L".join(f"{f(x)} {f(y)}" for x,y in pts)+"Z"
def circ(cx,cy,r): return f"M{f(cx-r)} {f(cy)}a{f(r)} {f(r)} 0 1 0 {f(2*r)} 0a{f(r)} {f(r)} 0 1 0 {f(-2*r)} 0Z"
def thick(pts,h):
    """outline of a polyline of half-width h, flat caps, mitred joins"""
    L=[];R=[]
    n=len(pts)
    def nrm(a,b):
        dx,dy=b[0]-a[0],b[1]-a[1]; l=math.hypot(dx,dy); return (-dy/l,dx/l)
    for i,p in enumerate(pts):
        if i==0: nx,ny=nrm(pts[0],pts[1]); m=1
        elif i==n-1: nx,ny=nrm(pts[-2],pts[-1]); m=1
        else:
            a=nrm(pts[i-1],p); b=nrm(p,pts[i+1]); nx,ny=a[0]+b[0],a[1]+b[1]; l=math.hypot(nx,ny); nx,ny=nx/l,ny/l
            m=1/(nx*a[0]+ny*a[1])
        L.append((p[0]+nx*h*m,p[1]+ny*h*m)); R.append((p[0]-nx*h*m,p[1]-ny*h*m))
    return L+R[::-1]
def svg(title, body, vb="0 0 256 256"):
    w,h=vb.split()[2:]
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img"><title>{title}</title>{body}</svg>\n'
# base geometry (A v2), y already shifted +4
chev=[(78,90),(28,140),(78,190),(95,190),(45,140),(95,90)]
earL=[(78,90),(102,90),(90,62)]
right=[(104,190),(168,62),(178,90),(228,140),(178,190)]
DARK, ORANGE, LIGHT = "#2B2B2B", "#FF9F5F", "#F4EFE9"
pad=lambda cx,cy: circ(cx,cy,10)+" "+circ(cx,cy,4)
t1=thick([(158+9.17,124),(184,124),(194,114)],4)
t2=thick([(158+9.17,156),(184,156),(194,166)],4)
def symbol_parts():
    return {
      'bracket': P(chev),
      'ear': P(earL),
      'eye': circ(84,140,13)+" "+circ(84,140,5),          # a via: ring with a centre
      'half': f"{P(right)} {pad(158,124)} {pad(158,156)} {P(t1)} {P(t2)}",  # whisker traces knocked out
    }
def symbol(bracket=ORANGE, accent=ORANGE, dx=0, dy=0):  # all orange: works on light and dark
    p=symbol_parts(); g=f'<g transform="translate({dx} {dy})">' if dx or dy else '<g>'
    return (g+f'<path fill="{bracket}" d="{p["bracket"]}"/>'
            f'<path fill="{accent}" d="{p["ear"]}"/>'
            f'<path fill="{accent}" fill-rule="evenodd" d="{p["eye"]}"/>'
            f'<path fill="{accent}" fill-rule="evenodd" d="{p["half"]}"/></g>')
# small-size cut (16–32 px): solid left shard with the eye knocked out, no traces
gl=89; sx=lambda y,b: b+(190-y)*0.5
shard=[(28,140),(78,90),(90,62),(102,90),(sx(90,gl),90),(gl,190),(78,190)]
def small(bracket=ORANGE, accent=ORANGE):
    return (f'<path fill="{bracket}" fill-rule="evenodd" d="{P(shard)} {circ(84,140,12)}"/>'
            f'<path fill="{accent}" d="{P(right)}"/>')
# wordmark "CatSim": monoline, 45° chamfers like the mark; stroke 18, cap 100, x-height 76, baseline 200
H=7
def L(*pts, ox=0): return P(thick([(x+ox,y) for x,y in pts],H))
def word_paths():
    x=0; cat=[]; sim=[]
    cat.append(L((72,109),(23,109),(9,123),(9,177),(23,191),(72,191),ox=x)); x+=72+16          # C
    cat.append(L((9,133),(41,133),(55,147),(55,198),ox=x)); cat.append(L((55,162),(21,162),(9,174),(9,179),(21,191),(55,191),ox=x)); x+=64+16  # a
    cat.append(L((18,104),(18,177),(32,191),(48,191),ox=x)); cat.append(L((0,133),(44,133),ox=x)); x+=48+16  # t
    sim.append(L((68,109),(23,109),(9,123),(9,136),(23,150),(54,150),(68,164),(68,177),(54,191),(0,191),ox=x)); x+=77+16  # S
    sim.append(L((9,133),(9,198),ox=x)); sim.append(circ(9+x,110,10)); x+=18+16                  # i
    sim.append(L((9,198),(9,133),(36,133),(46,143),(46,198),ox=x)); sim.append(L((46,143),(56,133),(73,133),(83,143),(83,198),ox=x)); x+=92
    return cat, sim, x
def wordmark(cat_fill=DARK, sim_fill=ORANGE, dx=0, dy=0):
    cat,sim,w=word_paths()
    return (f'<g transform="translate({dx} {dy})"><path fill="{cat_fill}" d="{" ".join(cat)}"/>'
            f'<path fill="{sim_fill}" d="{" ".join(sim)}"/></g>'), w

if __name__ == '__main__':
    def out(name, body, vb="0 0 256 256", title='CatSim logo'): open(name, 'w').write(svg(title, body, vb))
    out('catsim-symbol.svg', symbol())
    out('catsim-symbol-small.svg', small(), title='CatSim logo (small sizes)')
    wm, w = wordmark(dy=-64, dx=4); out('catsim-wordmark.svg', wm, f"0 0 {w+8} 120", 'CatSim wordmark')
    gap = 40; total = 228 + gap + w + 28
    out('catsim-horizontal.svg', symbol() + wordmark(dx=228+gap, dy=-24)[0], f"0 0 {total} 256")
    out('catsim-horizontal-on-dark.svg', symbol() + wordmark(cat_fill=LIGHT, dx=228+gap, dy=-24)[0], f"0 0 {total} 256")
    # tab icon: the mark on an ink circle, so it reads on light and dark tab bars
    sc = 1.08; off = 128 - 128 * sc
    out('web/favicon.svg', f'<circle cx="128" cy="128" r="128" fill="{DARK}"/>'
        + symbol().replace('<g>', f'<g transform="translate({off:.2f} {off:.2f}) scale({sc})">', 1), title='CatSim')
    print('wrote the CatSim logo SVGs')
