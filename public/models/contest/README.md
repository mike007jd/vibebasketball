# Vibe three-point contest props

`vibe-contest-props.glb` — one file, two props, two LODs each. Original
geometry, no textures, no third-party source, no third-party marks.

| root       | LOD0 tris | LOD1 tris | draw groups (per LOD) | footprint     | height |
| ---------- | --------: | --------: | --------------------: | ------------- | -----: |
| `Rack`     |     4 312 |     1 164 |                     5 | 1.36 × 0.59 m | 0.86 m |
| `Pedestal` |     1 952 |       520 |                     4 | 0.61 m ⌀      | 0.88 m |

## Scene contract

Metres, Y-up, hoop toward −Z — the same axes the game scene uses. The numbers
below match what `src/world/contestRacks.js` already places its rack balls at;
the asset was built to that contract, not the other way round.

* Both roots sit at the world origin with their feet on `y = 0`. Position an
  instance by dropping it straight onto the court plane; no offset needed.
* The emblem faces local **−Z**. The scene yaws each instance with
  `rotation.y = atan2(rimX − x, rimZ − z)`, which points local +Z at the hoop —
  so the emblem ends up facing the shooter and the broadcast camera.
* Rack: five slots on a **0.27 m pitch** at `x = −0.54, −0.27, 0, 0.27, 0.54`,
  a seated ball's centre at **`y = 0.91`**.
* Pedestal: one cradle, a seated ball's centre at **`y = 0.93`**.
* Cradle rings are 0.095 m in radius, so they seat the scene's 0.119 m rack ball
  and the 0.121 m game ball alike (0.003 m apart in resting height). Adjacent
  0.238 m balls leave 0.032 m of air.
* **Decorative only.** No collider ships in the GLB and none should be
  generated — the ball is never meant to interact with these.

## Loading

One load, clone per station:

```js
const gltf = await loader.loadAsync('/models/contest/vibe-contest-props.glb');
const rackProto = gltf.scene.getObjectByName('Rack');
const pedProto  = gltf.scene.getObjectByName('Pedestal');

function station(proto, lod = 0) {
  const inst = proto.clone(true);
  inst.getObjectByName(`${proto.name}_LOD${1 - lod}`).visible = false;  // required
  return inst;
}
```

**Cloning a root gives you both LODs.** `Rack` contains `Rack_LOD0` *and*
`Rack_LOD1`, stacked at the same origin. A consumer that clones the root without
hiding one draws both — roughly 27 % wasted triangles and z-fighting on every
coplanar accent. Hide the LOD you are not showing, as above.

three.js splits each multi-material mesh into one child per material, so
`Rack_LOD0` arrives as a `Group` of five `Mesh` children named `Rack_LOD0_1…5`.
Hiding the `Group` hides all of them, which is what the snippet relies on.

The two LODs are separate builds rather than a decimation. Every shape here is a
revolved or extruded primitive, so LOD1 is the same construction at lower segment
counts with the smallest trim (tie bars, cup collars, column flutes, the apron's
top edge stripe) dropped. The silhouette and every accent placement are
identical — see `previews/lod0-vs-lod1.jpg`. LOD1 is ~27 % of LOD0 and is meant
for the far side of the arc.

## Materials

Five untextured PBR materials, shared across both props:

| material           | base color | metalness | roughness | note                      |
| ------------------ | ---------- | --------: | --------: | ------------------------- |
| `VibeCastMetal`    | `#1b1f26`  |      0.85 |      0.44 | frames, aprons, columns   |
| `VibeSteel`        | `#4f5a66`  |      0.92 |      0.28 | rails, cradle rings, neck |
| `VibeGrip`         | `#0d0f13`  |      0.05 |      0.94 | floor skids               |
| `VibeAccentTeal`   | `#16a3ba`  |      0.35 |      0.34 | emissive `#085d6b`        |
| `VibeAccentOrange` | `#f26f1e`  |      0.35 |      0.34 | emissive `#8c3a0d`        |

The accents carry a modest core-glTF `emissiveFactor` (no extension, strength
≤ 1). The court is a night exterior under four spots with exponential fog; an
unlit accent out at the arc reads as a grey smudge from the broadcast camera.

## Rebuilding

```sh
blender -b --python tools/blender/contest_props.py -- \
    --out public/models/contest/vibe-contest-props.glb

blender -b --python tools/blender/contest_props.py -- \
    --previews public/models/contest/vibe-contest-props.glb \
    --shots-dir public/models/contest/previews
```

The first command authors, exports and seals `manifest.json`. The second cold
imports the exported GLB into a fresh Blender, renders `previews/`, and stamps
the cold-import findings and preview hashes back into the manifest. Run them in
that order — the preview pass edits the manifest the build pass wrote.

Hashes, tool versions, provenance and acceptance evidence live in
`manifest.json` and `ACCEPTANCE.md`.
