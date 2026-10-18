# PHASE 2: The 5'9" Athletic Protagonist, Kajiya-Kay Silky Black Hair Shader & Gear-Shedding System

> The user's Phase 2 prompt, recorded verbatim, followed by **adaptations**: decisions the user made after this
> prompt was written. Where they conflict, the adaptations win.

## ORIGINAL PROMPT

Build the protagonist character rig, custom anisotropic black hair wind shader, procedural skeletal animation state
machine, and the 4-stage equipment-shedding mechanic.

### DELIVERABLES FOR PHASE 2 (FULL COMPILABLE CODE, NO OMISSIONS)

1. **`src/three/shaders/SilkyHairShader.ts`:**
   - Implement a custom GLSL `ShaderMaterial` using the **Kajiya-Kay anisotropic specular model** tuned for silky
     jet-black hair (`#090a0f` base, dual specular shifts, wind-driven strand tip wave displacement in the vertex
     shader).

2. **`src/three/character/ProtagonistModel.tsx`:**
   - Construct an articulated humanoid rig scaled to **5'9" (`1.75m`)** with a fit, athletic Tom Cruise / James Bond
     V-taper silhouette (broad shoulders, sculpted chest, lean waist, fitted charcoal tactical expedition jacket,
     dark climbing trousers, and layered silky black hair mesh).
   - Support an optional `glbUrl?: string` override while defaulting to the high-detail procedural articulated rig
     so it runs with zero external asset failures.
   - Expose hierarchical bone refs (`Root`, `Pelvis`, `Spine`, `Chest`, `Neck`, `Head`, `LeftArm`, `LeftForeArm`,
     `LeftHand`, `RightArm`, `RightForeArm`, `RightHand`, `LeftUpLeg`, `LeftLeg`, `RightUpLeg`, `RightLeg`).

3. **`src/three/character/CharacterAnimator.ts`:**
   - Frame-rate-independent procedural kinematics blending joints smoothly across:
     - `0.08 - 0.18` (`HERO_IDLE`): Grounded athletic stance, chest breathing, subtle head turn.
     - `0.18 - 0.28` (`EQUIPPING_STANCE`): Checking gear as tools lock onto bones.
     - `0.28 - 0.45` (`CLIMB_WALL_1`): 4-limb rock climbing reach-and-pull cycle.
     - `0.45 - 0.52` (`JUMP_CHASM_1`): Explosive takeoff, mid-air tuck, 2-point landing on Ledge 2.
     - `0.52 - 0.62` (`CLIMB_WALL_2`): Agile ridge ascent.
     - `0.62 - 0.71` (`EXTREME_LEAP_CHASM_2`): Running dive across the 12-unit abyss -> **at `0.68 - 0.70`, dramatic
       one-handed cliff catch** hanging by `RightHand` -> powerful muscle-up onto Ledge 3 at `0.71`.
     - `0.71 - 0.78` (`PURE_SKILL_SCRAMBLE`): Fast bare-handed parkour climb to the Summit with 0 gear.
     - `0.78 - 0.92` (`SUMMIT_MASTERY`): Composed, experienced posture on the peak.
     - `0.92 - 0.95` (`THROW_PAPER`): Right arm whips forward toward the camera lens to throw the contact paper.

4. **`src/three/character/GearSheddingSystem.tsx`:**
   - Build 4 detailed 3D tools attached to the character's bones: `ExpeditionBackpack` (`Chest`),
     `ClimbingRopeCoil` (`Chest`), `DualCarbonIceAxes` (`Hands/Hips`), and `TacticalHarnessRack` (`Pelvis`).
   - **Scroll-Driven Shedding Logic:**
     - `0.00 - 0.18`: All hidden (`activeGearCount = 0`).
     - `0.18 - 0.28`: All 4 lock in sequentially with spring scale (`activeGearCount = 4`).
     - **At `0.42` (Company 1):** `ExpeditionBackpack` detaches and falls into the canyon with gravity
       (`activeGearCount = 3`).
     - **At `0.56` (Company 2):** `ClimbingRopeCoil` detaches and drops into Chasm 1 (`activeGearCount = 2`).
     - **At `0.72` (Company 3):** `DualCarbonIceAxes` and `TacticalHarnessRack` detach and fall away
       (`activeGearCount = 0`), leaving the climber 100% gear-free for the Summit.

## ADAPTATIONS (user decisions made after this prompt; these win)

1. **Gear timeline: the backpack is kept to the end.** The user chose this so the contact paper can blow out of the
   backpack at the summit. The source of truth is `GEAR_DROP_AT` / `gearCountAt` in `src/store/scrollStore.ts`.
   - `0.00–0.18`: no gear shown (0/4).
   - `0.18–0.28`: all 4 lock on in sequence with spring scale (4/4).
   - **`0.42` (Company 1):** the `ClimbingRopeCoil` detaches and falls into the canyon (3/4).
   - **`0.56` (Company 2):** the `TacticalHarnessRack` detaches and drops into Chasm 1 (2/4).
   - **`0.72` (Company 3):** the `DualCarbonIceAxes` fall away (1/4).
   - The `ExpeditionBackpack` stays on, on the back via the `Chest`/`Spine` bone, through the summit and the ending.
2. **The Chasm 2 catch is bare-handed.** During `EXTREME_LEAP_CHASM_2` the ice axes are holstered at the hips (on
   the `Pelvis` bone), so the `0.68–0.70` one-handed catch by `RightHand` is pure skill. They drop at `0.72` for the
   bare-handed `PURE_SKILL_SCRAMBLE`, which carries only the backpack. Note: an older comment in `scrollStore.ts`
   says the axes drop *before* the leap. That is wrong, because 0.72 comes after the catch, and it is corrected
   during Phase 1 integration.
3. **There is no paper throw.** The user said "the paper throw seems fake". The ending is now timed by `ENDING` in
   `src/three/world/worldLayout.ts`:
   - `0.78–0.86 SUMMIT_MASTERY`: composed, triumphant, **facing the camera (+z)** for the front-three-quarter shot.
   - `0.86–0.88`: turns around to face the next mountain (-z), **back to the camera** for the over-the-shoulder
     reveal.
   - `0.86–0.945 SUMMIT_MASTERY / LAST_PULL`: standing before the next big, continuous mountain (`NEXT_MOUNTAIN`),
     ready for the next journey: weight settled, gaze up at it, maybe a hand on a backpack strap.
   - `0.945–0.955 GUST`: the wind hits. Jacket and hair whip, the body braces and the head turns slightly. The
     backpack's top flap flips open and the paper escapes from `ENDING.paperOrigin` `[0,56.25,-34.7]`. The backpack
     flap must line up with that point, and the paper itself is `LensPaper` from Phase 1.
   - `0.955–1.0`: holds the stance in the wind, visible behind the paper on the lens, and dissolves with the world.
4. **Facing elsewhere:** while climbing, the protagonist faces the rock (back to the camera). At base camp
   (Scenes 2–3), they face the camera for the heroic framing. Positions come from `protagonistPositionAt(progress)`
   in `src/three/protagonistPath.ts`, at **feet** level.
5. **Likeness:** match the athletic *build and silhouette* only (V-taper, 5'9", fitted charcoal tactical jacket,
   dark trousers, silky black hair). Never model a real person's likeness.
6. **One continuous mountain:** all climbing contact points are on the Phase 1 terrain. Hands and feet should
   plausibly touch the rock built by `terrainGeometry.ts`, which Phase 2 may raycast against.
