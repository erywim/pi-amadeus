# Live2D 表情与动作系统

红莉栖模型的表情、动作、漫画符号全部由代码驱动，没有修改模型文件（仓库里没有 `.cmo3` 工程和 PSD 原画，模型本身改不了）。本文说明能做什么、怎么接入大模型、怎么新增和调参。

## 1. 模型能力边界（实测）

`红莉栖.moc3` 有 45 个参数，其中 15 个没有任何绑定，写了也没效果：全部 `ParamBrow*`、`ParamEyeLSmile/RSmile`、`ParamCheek`、`Param17`、`ParamHairFront/Side/Back`。实际可用的是：

| 能力 | 参数 / 网格 | 说明 |
|---|---|---|
| 六张情绪脸 | `Param3` 害羞、`Param4` 开心、`Param5` 生气、`Param6` 难过、`Param7` 娇羞、`Param8` 惊讶 | 眉毛画在脸里；两张脸不能混合；0..1 中间值是形变插值 |
| 眼睛 | `ParamEyeLOpen/ROpen`、`ParamEyeBallX/Y` | 可半睁、闭眼、单眼眨；开心脸 + 闭眼 = ^^ 笑眼；眼珠移动幅度很小 |
| 嘴 | `ParamMouthForm`、`ParamMouthOpenY` | 只有嘴角上下和张合，做不出元音口型 |
| 头部 | `ParamAngleX/Y/Z`（小幅）、`Param14/15`（大幅转头/俯仰） | 方向与 Live2D 标准一致；`ParamAngleZ` 歪头极弱（±30 只转约 4°），引擎另按 roll 让整个形象绕脖子旋转 |
| 身体 | `ParamBodyAngleX/Y/Z`、`ParamBreath` | 幅度小 |
| 手臂 | `Param16` | 只有"垂手 ↔ 抱臂"一种动作 |
| 脸红 | 网格 `lianhong/lianhong2`（粉色，两颊）、`ArtMesh51/53`（害羞脸自带的橙色红晕） | 通过覆盖网格不透明度，任何表情都能加减 |

**搁置**（需要用 Cubism Editor 改模型、画新图层）：挥手/指人/托腮等手部动作、独立的眉毛动作、元音口型、换装/换发型。

## 2. 大模型协议

语音模式下，LLM 在句对之前可以输出情绪行和动作行（`services/brain/src/persona.ts` 由共享词表自动生成提示词）：

```
【情】smug
【动】hmph
【日】ふん、そんなの当然でしょ。
【中】哼，那不是理所当然的嘛。
```

- 情绪 25 种、动作 13 种，词表与中文含义在 `packages/shared/src/emotion.ts`（`EMOTIONS` / `GESTURES`），提示词和预览界面都从这里取。
- 解析器（`services/brain/src/bilingual.ts`）容忍：一行多个标记、`【情绪】`/`【动作】` 等近似写法、附带中文说明、旧情绪名（`joy`、`shy2`、`smile1` 等会映射到新名字）；无法识别的情绪/动作直接丢弃，不会显示成正文。
- SSE 事件：`emotion`（持续状态）与 `gesture`（一次性动作），前端写入 `live2dStore`，引擎订阅后执行。
- 情绪在空闲 30 秒后自动回落到 `neutral`。

## 3. 代码结构（`apps/desktop/src/renderer/src/features/live2d/lib/`）

| 文件 | 职责 |
|---|---|
| `model-params.ts` | 模型参数/网格 ID 与实测方向符号——唯一的事实来源 |
| `expressions.ts` | 25 个情绪配方：情绪脸、眼、嘴、视线、头部姿态、手臂、脸红、漫画符号、入场/待机手势 |
| `gestures.ts` | 程序手势：关键帧曲线，叠加在表情与待机摆动之上，可同时播放、可左右镜像 |
| `overlays.ts` | 漫画符号（眼泪、汗滴、青筋、阴影线、问号、感叹号、闪光、冒烟、省略号、ZZZ、脸红斜线），挂在模型容器里随头部移动、歪头 |
| `drawable-fx.ts` | 在 Cubism Core 算完网格后、渲染前覆盖网格不透明度（脸红） |
| `procedural-layer.ts` | 每帧合成并写参数：配方基线 → 平滑 → 待机摆动/注视/说话点头 → 叠加手势；换脸时先退旧脸再进新脸 |
| `live2d-engine.ts` | 装配各层；订阅情绪/动作；空闲回落；调试钩子 `window.__live2d` |
| `idle.ts` | 待机调度：眨眼、视线游移、按当前表情选择待机手势或模型自带随机动作 |

模型自带的 `random1-5` 动作只在 `neutral` 下作为待机动作播放（它们会暂时覆盖眼、嘴、头，其他表情用各自的程序手势），原来的 10 个 `.exp3.json` 与情绪动作文件不再用于情绪表现。

判断方向时只看放大的固定区域截图（或做像素测量）：缩略图和跟随头部移动的裁剪框都容易看反。

## 4. 新增或调整一个情绪

1. 在 `packages/shared/src/emotion.ts` 的 `EMOTIONS` 与 `EMOTION_LABELS` 加名字和中文含义（提示词自动更新）。
2. 在 `expressions.ts` 的 `EXPRESSIONS` 写配方；三个语言包里补 `live2d.emotion.<名字>`。
3. 截图对比调参（见下节），满意后把数值写回配方。

## 5. 截图调参工具

```bash
# 只启动渲染层（无需 Electron 与 brain 服务）
cd apps/desktop && node scripts/renderer-dev.mjs --port 5199

# 另一个终端：按计划截图并生成拼图
node scripts/live2d-shot.mjs --url http://localhost:5199/live2d \
  --plan-json '{"clip":"face","shots":[
    {"name":"a","js":"E.previewRecipe({face:\"angry\",eyeOpen:0.55,mouthForm:-0.4})"},
    {"name":"b","js":"E.emote(\"tsundere\")","waitMs":2500}]}' \
  --sheet sheet --dpr 2
```

脚本会自己起一个 headless Chrome（可并行多个），隐藏界面、冻结待机随机性后逐条执行并截图。页面里 `E` 是引擎调试钩子：

| 接口 | 用途 |
|---|---|
| `E.emote(name)` | 切情绪（与 SSE 事件同一路径，含入场手势） |
| `E.gesture(name)` | 播动作（含内部手势 `yawn`、`glance`） |
| `E.previewRecipe(recipe, withEntry?)` | 直接应用一份临时配方 |
| `E.debugDefineGesture(name, def)` | 临时覆盖一个手势定义 |
| `E.debugRecipes()` / `E.debugGestures()` / `E.debugParams(ids)` | 读当前配方、手势、参数值 |

应用内也可以在「配置 → 表情」页逐个点击预览全部情绪和动作。
