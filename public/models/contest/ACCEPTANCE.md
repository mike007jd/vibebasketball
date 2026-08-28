# Acceptance — three-point contest props

| field      | value                             |
| ---------- | --------------------------------- |
| workstream | `three-point-contest-props`       |
| provider   | `claude-code`                     |
| model      | `claude-opus-5`                   |
| effort     | `medium`                          |
| timestamp  | `2026-08-27T14:35:59Z`            |
| verdict    | **PASS** — see gaps at the bottom |

## Artefacts and hashes

| file                                            |   bytes | sha256 |
| ----------------------------------------------- | ------: | ------ |
| `tools/blender/contest_props.py`                |  27 488 | `33d5b1ee42f1d97a09851ef42238b121168127f691cf596c9f49a791d8be34b1` |
| `public/models/contest/vibe-contest-props.glb`  | 273 628 | `6cb33aa27cd03d813ca1772ee1ae2065ade1eb73f5ddc1caf5248b4857b4baf9` |
| `previews/front.jpg`                            |  88 912 | `a1ebdfbc02eb50cb4dc697ba20bc566ae5f33983dd958ac48e0214d33610c8c0` |
| `previews/three-quarter.jpg`                    |  93 176 | `e1fcd5af17eb107c3c9d7b5e4dc45d81b47aa4e73dcaa752f2f287ac352f2d09` |
| `previews/top.jpg`                              |  64 870 | `f30ec946e370a011af41624d2fe5093998081760693ec470bc3a9a8d08f05f3c` |
| `previews/fit-check.jpg`                        |  93 945 | `25cefecec4defdfb1c5f88fc811ad22e2f55fbe1ed2b3b47081bf47a832b2dbc` |
| `previews/lod0-vs-lod1.jpg`                     |  77 983 | `bcbed847fd80be2cdcde2cd6e69fc9ec4deb4cbc60e2b8b0256c8ffea4e97562` |
| `previews/broadcast-14m.jpg`                    |  45 800 | `8373cfd87f82bb57adf0f403c8d3b6e31b2a3ffc395975dc6d29e1586ad80b13` |

The same hashes are sealed machine-readable in `manifest.json`, which also
carries the scene contract, per-LOD triangle counts, material lists and Y-up
bounds.

## Tool versions

* Blender 5.2.0 LTS (`fbe6228777e7`, built 2026-07-14), bundled Python 3.13.13
* Blender glTF 2.0 exporter 5.2.39 (Draco and MeshOptimizer both available and
  both deliberately unused — the GLB stays decoder-free for portability)
* three.js 0.170.0 (`node_modules/three`), Node.js 24.18.0
* darwin / macOS 25.6.0

## Commands run

```sh
# author, export, seal manifest
/Applications/Blender.app/Contents/MacOS/Blender -b \
  --python tools/blender/contest_props.py -- \
  --out public/models/contest/vibe-contest-props.glb

# cold import the exported GLB into a fresh Blender, render previews,
# stamp cold-import findings + preview hashes into the manifest
/Applications/Blender.app/Contents/MacOS/Blender -b \
  --python tools/blender/contest_props.py -- \
  --previews public/models/contest/vibe-contest-props.glb \
  --shots-dir public/models/contest/previews

# three.js cold import, using the consuming module's own lookup (repo root)
node --input-type=module <<'JS'
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const b = fs.readFileSync('public/models/contest/vibe-contest-props.glb');
new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', (g) => {
  let tris = 0, meshes = 0;
  g.scene.traverse(o => { if (o.isMesh) { meshes++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
  console.log('roots', g.scene.children.map(c => c.name), 'meshes', meshes, 'tris', tris, 'anims', g.animations.length);
  const findNamed = (root, re) => { let f = null; root.traverse(o => { if (!f && re.test(o.name ?? '')) f = o; }); return f; };
  console.log('consumer findNamed ->', findNamed(g.scene, /(^|_)rack($|_)/i)?.name,
                                       findNamed(g.scene, /pedestal|logo.*stand|range.*stand/i)?.name);
  const steel = new THREE.Box3().setFromObject(g.scene.getObjectByName('Rack_LOD0_1'));
  console.log('ball centre lands at', (steel.max.y - 0.018 + Math.sqrt(0.119 ** 2 - 0.095 ** 2)).toFixed(4));
});
JS
```

`--previews` runs in a factory-reset Blender that imports only the exported
GLB, so nothing from the authoring session leaks into the check.

## Acceptance criteria

**Five 0.24 m basketballs fit the rack — PASS.**
`previews/fit-check.jpg` seats a gauge sphere in every cradle. The gauge is
0.250 m across — deliberately larger than both the scene's 0.238 m rack ball and
the 0.242 m game ball — and all five still clear each other and the rails. At
the scene's 0.27 m slot pitch a 0.238 m ball has 0.032 m of air on each side.
Cradle rings are 0.095 m in radius, putting a seated 0.119 m ball's centre
`sqrt(0.119² − 0.095²) = 0.0717` m above the ring plane. Measured off the
exported GLB through three.js, that lands at **0.9100 m** on the rack and
0.9297 m on the pedestal, against the 0.91 / 0.93 the scene places its balls at.

**Silhouette reads at broadcast distance — PASS.**
`previews/broadcast-14m.jpg` is a 50 mm camera 14 m out at 2.9 m eye height,
which is where these are actually seen from. The five-cradle rhythm, the rack's
A-frames, the pedestal's tapered column and both accent stripes all resolve.
Two changes came out of looking at earlier passes: the front apron originally
stood 0.10 m proud of the frame and read as a barricade board rather than part
of the rack, so it now hangs off the front rail flush with the legs; and the
centre A-frame was split into a pair straddling x=0, because a leg on the
centreline bisected the emblem from exactly the angle the emblem is read at.

**PBR dark metal with teal/orange Vibe accents — PASS.**
Five untextured materials, values in `README.md`. Base colours are lifted from
the game's own palette: teal off `#57dff6`/`#1d5a5e` in the HUD and court, orange
off `#ff9a3c`/`#cf5019` on the rim pads and away-team type. Accents carry a
modest core-glTF `emissiveFactor` (≤ 1, no `KHR_materials_emissive_strength`)
because the court is a fogged night exterior. Verified through three.js:
`VibeAccentTeal` arrives as `MeshStandardMaterial` colour `16a3ba`, metalness
0.35, roughness 0.34, emissive `085d6b`.

**No third-party marks — PASS.**
Every vertex is generated from Blender primitives in `contest_props.py`. There
is no imported mesh, no texture, no image of any kind in the GLB, and no text.
The only mark is an original chevron — a wide V with a detached bar above it —
modelled as geometry. No NBA, State Farm, Starry, Wilson or any other
third-party mark, wordmark, trade dress or licensed shape is present or
referenced.

**Cold-imports in Blender and three.js — PASS.**
Blender: factory-reset import found all six expected objects
(`Rack`, `Rack_LOD0`, `Rack_LOD1`, `Pedestal`, `Pedestal_LOD0`,
`Pedestal_LOD1`), no errors, no warnings.
three.js 0.170.0 `GLTFLoader.parse` returns:

```
roots [ 'Pedestal', 'Rack' ] meshes 18 tris 7948 anims 0
consumer findNamed -> Rack Pedestal
Rack     bbox min [-0.680, 0.002, -0.296] max [0.680, 0.856, 0.296]
Pedestal bbox min [-0.305, 0.000, -0.305] max [0.305, 0.876, 0.305]
teal accent (apron + emblem) z-range -0.154 … -0.137   (emblem on -Z, as specified)

Group "Scene"
  Object3D "Pedestal"
    Group "Pedestal_LOD0"   Mesh "Pedestal_LOD0_1" … "_4"
    Group "Pedestal_LOD1"   Mesh "Pedestal_LOD1_1" … "_4"
  Object3D "Rack"
    Group "Rack_LOD0"       Mesh "Rack_LOD0_1" … "_5"
    Group "Rack_LOD1"       Mesh "Rack_LOD1_1" … "_5"
```

`position` + `normal` attributes only, 0 animations, 0 textures, no extensions
required. UVs and tangents are intentionally not exported — there are no
textures, and dropping them took the GLB from 351 KB to 274 KB.

**Decorative only, no collision — PASS.**
No collider mesh, no `UCX_`/`Collision` node, no physics extension in the GLB.
The 3DAssets `static_prop` config defaults to `collision_mode: "coacd"`; that
stage was deliberately not run, and the exclusion is recorded in
`manifest.json` under `scene_contract.collision`.

**LOD0 / LOD1 — PASS.** Both ship in the same GLB.

| root       | LOD0  | LOD1  | LOD1 share |
| ---------- | ----: | ----: | ---------: |
| `Rack`     | 4 312 | 1 164 |       27 % |
| `Pedestal` | 1 952 |   520 |       27 % |

`previews/lod0-vs-lod1.jpg` puts them side by side at the same angle. LOD1 is a
re-run of the same construction at lower segment counts, minus tie bars, cup
collars, column flutes and the apron's top edge stripe; silhouette and accent
placement are unchanged.

## Alignment with the game consumer

`src/world/contestRacks.js` defines the rack contract, so the asset was built to
the game's placement and lookup rules rather than to its own preference:

| the consumer expects                                  | asset |
| ----------------------------------------------------- | ----- |
| `/models/contest/vibe-contest-props.glb`               | that is the exported filename |
| `findNamed(/(^\|_)rack($\|_)/i)` and `/pedestal/i`     | matches roots `Rack`, `Pedestal` — verified above |
| rack balls at `x = −0.54 + i·0.27`, `y = 0.91`         | five cradles on that exact pitch, seating height 0.9100 |
| pedestal ball at `y = 0.93`                            | cradle seating height 0.9297 |
| ball radius `0.119`                                    | cradle ring 0.095 seats 0.119 and 0.121 alike |
| `prop.rotation.y` points local +Z at the hoop          | emblem authored on local −Z, so it faces the shooter |

The integrated consumer now hides each cloned root's `LOD1` subtree after load,
so the contest draws only LOD0 and avoids stacked geometry or coplanar accent
z-fighting. The browser contest probe also cold-loads the GLB through the real
game path and asserts `rackSet.source === 'glb'`.

## Remaining gaps

1. **No LOD switch distance measured.** LOD1 is provided and verified to match
   LOD0's silhouette, but the crossover distance has not been profiled.
2. **Rack cradle depth is visual, not simulated.** A ball placed in a cradle
   must be positioned at the documented height; nothing in the asset holds it
   there, since there is no collision by design.
