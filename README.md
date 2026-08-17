# dsh-voice-core

共享语音引擎（Shared Voice Engine）—— dsh-teacher 与 dsh-companion 的公共底层。

一个 **library**，不是独立插件：消费插件（dsh-teacher / dsh-companion）在自己的
`apply()` 里调用 `applyVoice(ctx, config)`（host 侧），client 侧通过
`createVoiceClient(opts)` 组合共享 UI。语音由 mac mini 上的 **Qwen3-TTS**
（VoiceDesign，MPS 加速）生成，浏览器播放——声音从使用者自己的机器出来。

## 提供的能力

**Host（`applyVoice(ctx, config)`）**
- Qwen3-TTS 代理路由：`{ttsPath}`（如 `/dsh-teacher/tts`）+ `-health`，转发到
  本地 TTS 服务（`127.0.0.1:3091`，可用 `DSH_VOICE_TTS_URL` 覆盖）
- `speak` / `cheer` 模型工具（log-only `voice/*` 事件）
- `/speak /cheer /cheer-at /cheer-text /voice` 命令
- `voiceSpeak` 会话投影（fold `voice/speak` / `voice/spoken` / `voice/cheer`）
- 每日问候调度器：到点 `agent.followup` 让 Agent 自己生成"欢迎 + 趣闻/新闻"
  （或配置固定文案直接朗读）；`schedulerEnabled` 控制开关
- 音色配置驱动：`config.styles`（音色目录）+ `config.defaultStyle`

**Client（`createVoiceClient(opts)`）**
- 无内置 UI（不渲染任何图标/按钮）——只提供底层行为：自动朗读、音频播放、
  💛 cheer 卡片，配置/选择界面完全交给消费插件自己实现
- 音频队列播放（fetch WAV → `<audio>`，顺序播放不重叠）
- 自动朗读每条 assistant 回复（1s 先显示文字），带**按会话持久化的
  localStorage cursor** —— 切换会话/刷新页面不会重复朗读旧消息
- preset 门控：只在该消费插件的 agent preset 会话里生效
- `opts.resolveInstruct(sessionId)` 可选：按会话动态决定 TTS instruct（优先于 `defaultStyle` 的静态值），供需要"每个会话自己的音色"的消费者使用

## 配置示例

```js
// dsh-teacher 的 apply()
import { applyVoice } from 'dsh-voice-core'

await applyVoice(ctx, {
  presetName: 'teacher',
  ttsPath: '/dsh-teacher/tts',
  styles: { onee: { label: '🎧 清冷御姐', instruct: '清冷柔和的成年女声…' } },
  defaultStyle: 'onee',
  schedulerEnabled: false,
})
```

```js
// client 侧
import { createVoiceClient } from 'dsh-voice-core'

var voiceClient = createVoiceClient({
  presetName: 'teacher',
  ttsPath: '/dsh-teacher/tts',
  styles: { onee: { label: '🎧 清冷御姐', instruct: '…' } },
  defaultStyle: 'onee',
})
// 在 apply 里：voiceClient.apply(ctx)
```

## 安装

```bash
dsh plugin --profile web add github:Yihong89/dsh-voice-core
```

profile 的 `cordis.patch.yml` 注册事件：

```yaml
- insert:
    - id: dsh-voice-registrar
      name: dsh-voice-core/register-events
```

> pnpm 11 默认 `blockExoticSubdeps: true`，而 dsh-teacher/dsh-companion 把
> dsh-voice-core 作为 git 子依赖。若报
> `ERR_PNPM_EXOTIC_SUBDEP`，在 profile 的 `pnpm-workspace.yaml` 加
> `blockExoticSubdeps: false`。

## 测试

```bash
node --test test/*.test.js   # 49 tests
```

## License

MIT
