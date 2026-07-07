# Layout Recognize Complete Material List Plan

## Goal

Add a backend-powered feature to `layout-recognize` that generates a complete copy-pasteable material list from the current layout. The generated text is intended to be pasted into the main table parse page, then parsed by the existing parser.

The feature should calculate original cabinets/appliances plus accessory materials including DWP, RRP, BEP, WEP, VEP, PNL3696Q, TK, QR, SM, and CM.

## Confirmed Output Format

Use one item per line:

```text
02B15 x 2
02TK x 3
02QR x 2
02BEP x 1
02WEP x 1
02VEP x 1
02PNL3696Q x 1
```

Distance materials are rounded up by 96 inches and omitted with `96` in the SKU, for example `{color}TK`.

Side panels currently do not include dimensions except `PNL3696Q`:

- `{color}BEP`
- `{color}WEP`
- `{color}VEP`
- `{color}PNL3696Q`

If a block has no `colorCode`, do not infer color from `sku`. Generate the accessory item without a color prefix, for example `BEP x 1` or `TK x 1`. These colorless rows are intentional because the main page has a later flow that prompts for color. Missing `colorCode` must not be treated as UNIPACK.

## Existing Data Model

Relevant shared layout types exist in:

- `client/src/types.ts`
- `server/src/types/layout.ts`

Important fields:

- `LayoutDocument.walls`
- `LayoutWall.exposedLeft`
- `LayoutWall.exposedRight`
- `LayoutWall.exposedBack`
- `LayoutWall.airBlocks`
- `LayoutWall.groundBlocks`
- `SectionBlock.width`
- `SectionBlock.colorCode`
- `SectionBlock.items`
- `BlockItem.category`
- `BlockItem.sku`
- `BlockItem.isVanity`
- `BlockItem.height`

`connectedWallIds` must not be used for exposure logic. It means two walls may reference the same physical end item during automatic recognition. Exposure of end item is controlled only by `exposedLeft`, `exposedRight`, and `exposedBack`.

## Backend API Plan

Add a non-LLM API endpoint:

- `POST /api/layout/generate-list`

Request:

```ts
{
  layout: LayoutDocument;
}
```

Response:

```ts
{
  text: string;
  items: Array<{
    sku: string;
    quantity: number;
    source: string;
  }>;
  totals: {
    tkLength: number;
    qrLength: number;
    smLength: number;
    cmLength: number;
  };
  warnings: string[];
}
```

Implementation locations:

- Add pure algorithm service: `server/src/services/layout-material-list.ts`
- Add route: `server/src/routes/layoutGenerateList.ts`
- Add schema: `layoutGenerateListSchema` in `server/src/validation/schemas.ts`
- Register route in `server/src/index.ts` under normal authenticated `/api` routes, not under LLM routes.

## Constants

Define constants in the algorithm service:

```ts
const MATERIAL_STICK_LENGTH = 96;
const BASE_HEIGHT = 34.5;
const BASE_DEPTH = 24;
const VANITY_DEPTH = 21;
const WALL_DEPTH = 12;
const TALL_DEPTH = 24;
```

Height rules:

- Normal base cabinet height: `34.5`
- Vanity base cabinet height: `34.5`
- Wall cabinet height: from `BlockItem.height`
- Tall cabinet height: from `BlockItem.height`
- Tall appliance height: from `BlockItem.height`
- Wall cabinet stacked above tall appliance or tall cabinet depth: `24`
- Normal wall cabinet depth: `12`
- Tall cabinet depth: `24`
- Ground appliance depth: `24`
- Tall appliance depth: `24`

If an item height is missing where height is required, use `30` for wall cabinet, `15` for stacked wall cabinet and `96` for tall cabinet, then add warning for those defaults.

## Item Classification Helpers

Use small helpers in the service:

- `isGapLike`: `gap`, `window`, `range_hood`
- `isCabinet`: `base_cabinet`, `wall_cabinet`, `tall_cabinet`
- `isBaseCabinet`: `base_cabinet`
- `isWallCabinet`: `wall_cabinet`
- `isTallCabinet`: `tall_cabinet`
- `isTallAppliance`: `tall_appliance`
- `isBaseApplianceNeedTop`: `base_appliance_need_top`
- `isBaseApplianceWithoutTop`: `base_appliance_without_top`
- `isGroundObject`: base cabinet, tall cabinet, tall appliance, both base appliance categories
- `isAirObject`: wall cabinet, tall cabinet, tall appliance
- `hasStackedCabinetAbove`: an air block contains a `tall_appliance` plus at least one `wall_cabinet`, or contains a dual-track appliance with stacked items above it.

## Color Rules

Use `UNIPACK_STYLE_CODES` from `server/src/constants.ts`.

For cabinet side beautification:

- If `block.colorCode` is in `UNIPACK_STYLE_CODES`, skip BEP/WEP/VEP/PNL3696Q for cabinet side beautification.
- If `block.colorCode` is missing or empty, do not treat it as UNIPACK. Generate normal side beautification without color prefix.
- Do not infer color from `sku`.

For DWP/RRP frame side beautification:

- Always add `PNL3696Q` for exposed DWP/RRP frame sides, even if the frame color is UNIPACK.
- If not UNIPACK color, DWP should use BEP instead of `PNL3696Q`; RRP use `PNL3696Q` in any case.
- If the source block has no color, generate `PNL3696Q` without color prefix.

SKU building rule:

```ts
function withColor(colorCode: string | undefined, shape: string): string {
  return colorCode ? `${colorCode}${shape}` : shape;
}
```

## Original Cabinet And Appliance Rows

Traverse all walls and blocks.

Rules:

- Add every non-gap item with its `sku` as an original row.
- Avoid double counting dual-track items (`tall_cabinet`, `tall_appliance`) because they appear on both `airBlocks` and `groundBlocks`. Count them once by item id.
- Do not add `gap`, `window`, or `range_hood` as product rows.
- Aggregate identical SKU rows.

## DWP Rules

`base_appliance_need_top` requires DWP frame material.

Default:

- Add 2 DWP.

Exceptions:

- If the appliance is flush against the left wall edge and `wall.exposedLeft === false`, omit left DWP.
- If the appliance is flush against the right wall edge and `wall.exposedRight === false`, omit right DWP.

Wall edge detection:

- Compute each block start and end from cumulative widths.
- Left edge if `start === 0`.
- Right edge if `end === wall.width` or the block is the last meaningful ground block and cumulative end equals the total occupied width. Prefer exact `wall.width` when available.

DWP SKU:

- `{color}DWP`
- No dimensions for now.
s
Frame side exposure:

- Each DWP side that exists and is externally exposed needs one `PNL3696Q` if UNIPACK color, or BEP if non-UNIPACK color.
- The side between appliance and neighboring cabinet is not externally exposed.
- A side facing wall-edge exposure or a large gap is externally exposed.

## RRP Rules

`tall_appliance` requires RRP only if there is a stacked cabinet above it.

Default when stacked cabinet exists:

- Add 2 RRP.

Exceptions:

- If the appliance is flush against the left wall edge and `wall.exposedLeft === false`, omit left RRP.
- If the appliance is flush against the right wall edge and `wall.exposedRight === false`, omit right RRP.

If no stacked cabinet exists above the tall appliance:

- Add 0 RRP.

RRP SKU:

- `{color}RRP`
- No dimensions for now.

Frame side exposure:

- Each RRP side that exists and is externally exposed needs one `PNL3696Q`.
- The side between appliance and neighboring cabinet is not externally exposed.
- A side facing wall-edge exposure or a large gap is externally exposed.

## Side Beautification Panel Rules

These materials cover exposed cabinet sides for appearance.

Materials:

- Base cabinet: `BEP`
- Vanity base cabinet: `VEP`
- Wall cabinet: `WEP`
- Tall cabinet: `PNL3696Q`
- Tall appliance frame: `PNL3696Q`
- RRP frame: `PNL3696Q`
- DWP frame: `PNL3696Q`/`BEP`

Exposure sources:

- At wall left edge and `wall.exposedLeft === true`.
- At wall right edge and `wall.exposedRight === true`.
- Adjacent to a large opening: `gap`, `window`, or `range_hood`.
- A normal base cabinet adjacent to a vanity base cabinet: the normal base cabinet side is treated as exposed and needs `BEP`.

Non-exposure:

- Cabinet adjacent to appliance generally does not expose the cabinet side because appliance gaps are small.
- Cabinet adjacent to normal cabinet does not expose the side.
- Cabinet side beautification is skipped for UNIPACK cabinet colors.

Vanity adjacency special case:

- If ordinary `base_cabinet` is beside a `base_cabinet` with `isVanity`, the ordinary cabinet side adjacent to the vanity needs `BEP`.
- The vanity side follows its own normal exposure rules and uses `VEP` only when that vanity side is exposed by edge/gap/window/range hood or other explicit exposure.

## TK Rules

TK covers seams between side-by-side base cabinets.

Length:

- Sum widths of all `base_cabinet` ground blocks.
- Include vanity base cabinets.
- Include tall cabinets.
- Exclude all appliances.

Quantity:

- `ceil(tkLength / 96)`

SKU:

- `{color}TK`

Color grouping:

- Group TK length by block color.
- Missing color groups under empty color and emit `TK`.

## QR Rules

QR covers seams between ground objects and the floor.

Length equals total exposed ground perimeter by color group.

Ground object categories:

- `base_cabinet`
- `tall_cabinet`
- `tall_appliance` (for the frame side)
- `base_appliance_need_top` (for the frame side)

Depths:

- Base cabinet: `24`
- Vanity: `21`
- Ground appliance: `24`
- Tall cabinet: `24`
- Tall appliance: `24`

Rules:

- Front edge of base cabinets and tall cabinets counts by width.
- Front edge of appliances does not count.
- Side edge counts by depth if side is exposed.
- Back edge counts by width if `wall.exposedBack === true`.
- If a run is against a normal wall with `exposedBack === false`, the back edge does not count.
- Large openings (`gap`, `window`, `range_hood`) expose adjacent ground object sides.
- Appliances with DWP/RRP frames need side QR for frame-to-floor, but appliance front still does not count.

Examples:

- Continuous back-to-wall base cabinet run: `sum(width) + 2 * depth`.
- Same run with a gap splitting it: `sum(width) + 4 * depth`.

Quantity:

- `ceil(qrLength / 96)`

SKU:

- `{color}QR`

## SM Rules

SM covers seams between object sides and walls.

Length equals all side-exposed but back-not-exposed vertical heights by color group.

General:

- Only calculate SM when `wall.exposedBack === false` for the relevant back wall seam context.
- A side at `exposedLeft` or `exposedRight` contributes height.
- A side facing a large internal opening contributes height on both neighboring objects.
- Base appliances needing frames and tall appliances with frames need SM between frame and wall.

Heights:

- Base cabinet: `34.5`
- Vanity: `34.5`
- Wall cabinet: item `height`
- Tall cabinet: item `height`
- Tall appliance with stacked cabinet: appliance height plus stacked cabinet heights when represented as stacked air items.
- Tall appliance without stacked cabinet: no RRP, thus itself don't need SM as well as it's adjacent cabinets, since the tall applicance itself does not expose it's adjacent cabinets.

Simplified tall object rule:

- Tall cabinets and framed tall appliances span ground and air.
- If a tall cabinet or framed tall appliance side is adjacent to a ground cabinet or air cabinet, treat the whole side as exposed and add one full object height of SM.

Examples:

- A wall cabinet run with both ends exposed contributes `2 * wallCabinetHeight`.
- A base cabinet run with a middle gap contributes `4 * baseHeight`.
- A wall with fridge plus stacked cabinet, base cabinet run, and wall cabinet run, both left and right exposed, contributes `1 * baseHeight + 1 * wallHeight + 2 * fridgePlusStackHeight`.

Quantity:

- `ceil(smLength / 96)`

SKU:

- `{color}SM`

## CM Rules

CM covers seams between air objects and the ceiling. It is the ceiling version of QR.

Air object categories:

- `wall_cabinet`
- `tall_cabinet`
- `tall_appliance` with stacked cabinet above

Depths:

- Wall cabinet: `12`
- Wall cabinet stacked above tall cabinet/appliance: `24`
- Tall cabinet: `24`
- Tall appliance with stacked cabinet: `24`

Rules:

- Top/front exposed edge counts by width.
- Side edge counts by depth if side exposed.
- Back edge counts by width if `wall.exposedBack === true`.
- Large openings expose adjacent air object sides.
- Use QR-style contiguous segment logic on air blocks.

Quantity:

- `ceil(cmLength / 96)`

SKU:

- `{color}CM`

## Geometry Approach

For each wall and track:

1. Convert `SectionBlock[]` into positioned blocks:
   - `start`
   - `end`
   - `width`
   - `block`
2. Treat adjacent blocks as touching when `prev.end === current.start`.
3. Determine left and right neighbor categories by positioned index.
4. Determine edge exposure from wall flags:
   - `start === 0 && wall.exposedLeft`
   - `end === wall.width && wall.exposedRight`
5. Determine internal exposure when neighbor is large opening.

Do not use `connectedWallIds`.

## Aggregation

Use two maps:

- `itemQuantityBySku: Map<string, number>` for discrete items.
- `lengthBySku: Map<string, number>` for TK/QR/SM/CM raw lengths before 96-inch rounding.

After all lengths are accumulated:

- Convert each length SKU to quantity: `Math.ceil(length / 96)`.
- Skip zero or negative lengths.
- Add converted rows to `itemQuantityBySku`.

Sort output rows:

1. Original cabinets/appliances.
2. DWP/RRP.
3. Side panels.
4. Distance materials TK/QR/SM/CM.
5. Alphabetical within each group for stability.

## Frontend Plan

Modify `client/src/pages/LayoutRecognizePage.tsx`:

- Replace the current placeholder panel that says `更多功能 / 敬请期待` with a material list generator panel.
- Add local state:
  - `generatingList`
  - `generatedListText`
  - `generateListError`
  - `copyListSuccess`
- Add button: `生成完整清单`
- Add button: `复制清单`
- Add textarea showing generated text.
- Call `fetchWithAuth('/api/layout/generate-list', { method: 'POST', body: JSON.stringify({ layout: activeLayout }) })`.

Modify `client/src/pages/LayoutRecognizePage.css` minimally:

- Reuse existing `lr-btn` styles.
- Add compact panel styles for textarea and status line.
- Keep the existing visual language.

## Test Plan

Add `server/src/services/layout-material-list.test.ts`.

Use pure function tests without Express.

Suggested test cases:

1. Continuous base run
   - One wall, three base cabinets, back not exposed, both ends exposed.
   - Assert original cabinet rows, TK length, QR quantity, SM quantity.

2. Base run with middle gap
   - Base, gap, base.
   - Assert QR includes four side depths.
   - Assert SM includes four base heights when back is not exposed.

3. Wall cabinets with window/range hood gap
   - Wall cabinet, window, wall cabinet.
   - Assert WEP on sides facing window.
   - Assert SM side heights.

4. Vanity side rules
   - Normal base beside vanity.
   - Assert normal base side next to vanity gets BEP.
   - Assert vanity exposed outside side gets VEP.

5. UNIPACK cabinet side skip
   - Color `02` base/wall/tall cabinet exposed.
   - Assert cabinet BEP/WEP/PNL3696Q beautification is skipped.

6. UNIPACK frame side still covered
   - Color `02` base appliance need top at exposed edge.
   - Assert DWP exists and exposed frame side gets PNL3696Q.

7. Base appliance DWP edge omission
   - `base_appliance_need_top` flush left, `exposedLeft === false`.
   - Assert only one DWP.

8. Tall appliance without stacked cabinet
   - `tall_appliance` only.
   - Assert no RRP.

9. Tall appliance with stacked cabinet and side wall
   - `tall_appliance` plus stacked wall cabinet in same air block, flush right, `exposedRight === false`.
   - Assert one RRP.

10. 96-inch rounding
   - Accumulate length 97.
   - Assert quantity 2.

11. Missing color behavior
   - Exposed base cabinet with no `colorCode`.
   - Assert `BEP x 1`, not `{skuColor}BEP`.
   - Assert it is not skipped as UNIPACK even if `sku` starts with `02`.

Verification commands:

```powershell
npm test
npm run build
```

Run these inside `server` for backend changes. For frontend changes, run:

```powershell
npm run build
```

inside `client`.

## Implementation Notes

- Prefer small, deterministic helper functions over a large monolithic calculation.
- Keep the algorithm service independent of Express and browser APIs.
- Avoid introducing backward compatibility fields unless needed.
- Do not mutate the input layout.
- Add warnings rather than throwing for incomplete layout details such as missing heights.
- Keep tests focused on the confirmed behavior and avoid testing visual UI details.
