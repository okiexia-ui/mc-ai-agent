// 大脑：把玩家的自然语言指令交给 LLM，让它输出一个结构化动作 {action, args}。
// 用的是 OpenRouter（OpenAI 兼容接口），可用免费模型。

const SYSTEM_PROMPT = `你是一个 Minecraft 机器人的大脑。玩家会用自然语言（多为中文）给你下指令。
你的任务：把指令翻译成下面其中一个动作，并只输出一个 JSON 对象，不要任何解释、不要代码块。

可用动作：
- {"action":"come","args":{"player":"玩家名"}}        // 走到某玩家身边
- {"action":"follow","args":{"player":"玩家名"}}      // 持续跟随某玩家
- {"action":"goto","args":{"x":100,"y":64,"z":-200}}  // 去坐标
- {"action":"collect","args":{"block":"oak_log","count":5}} // 采集附近某方块(block用英文ID)
- {"action":"mine","args":{"direction":"forward","length":10}} // 挖矿/挖隧道,direction可填forward/down/up
- {"action":"craft","args":{"item":"oak_planks","count":4}} // 合成物品(item用英文ID)
- {"action":"attack","args":{"target":"zombie"}}      // 攻击:target可填怪名(zombie)、玩家名(打人PvP)、或"nearest"打最近的怪
- {"action":"place","args":{"block":"stone"}}         // 放方块(可选填x,y,z,不填则放身前)
- {"action":"eat","args":{}}                           // 吃东西回血(可选填food指定食物)
- {"action":"mount","args":{}}                         // 乘坐附近载具(可选填target如boat/horse)
- {"action":"dismount","args":{}}                      // 从载具下来
- {"action":"stop","args":{}}                          // 停止
- {"action":"inventory","args":{}}                     // 查看背包
- {"action":"say","args":{"text":"要说的话"}}          // 在聊天里说话

规则：
- block/item 必须用 Minecraft 英文 ID，例如 木头=oak_log，木板=oak_planks，石头=stone，煤矿=coal_ore，铁矿=iron_ore，箱子=chest，木棍=stick。
- 怪物名也用英文：僵尸=zombie，骷髅=skeleton，苦力怕=creeper，蜘蛛=spider。
- 区分 collect 和 mine：只要指明了"几个/某种方块或矿石"（如"挖3个铁矿""砍5个木头""挖点煤"）→ 用 collect 并填 block；只有"去挖矿/挖隧道/往下挖/往前挖N格"这种没指定具体方块、强调方向或挖洞的 → 才用 mine。
- "打/杀某个玩家(用人名)"也是 attack，target 填那个玩家名。
- "过来/到我这"用 come 并填说话人名字；"上船/坐船"用 mount，target填boat；"骑马"用 mount，target填horse。
- 可以参考下面的最近对话理解上下文（比如"再来一个""停下"指的是上一件事）。
- 如果听不懂或只是闲聊，用 say 友好地回应。
- 严格只输出 JSON。`

// 各家的 OpenAI 兼容接口地址
const ENDPOINTS = {
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
}

async function decideAction({ provider = 'zhipu', apiKey, model, speaker, message, history = [] }) {
  const userContent = `说话的玩家是 "${speaker}"。\n他说：${message}`
  const url = ENDPOINTS[provider]
  if (!url) throw new Error(`未知 provider: ${provider}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`${provider} 请求失败 ${res.status}: ${txt.slice(0, 200)}`)
  }

  const data = await res.json()
  const raw = data.choices?.[0]?.message?.content ?? ''
  return parseAction(raw)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 底层：发一组 messages 给 LLM，返回解析好的 JSON 对象。供 agent 循环用。
// 带自动重试：网络抖动(fetch failed)、限流(429)、服务端错(5xx) 都重试。
async function callJSON({ provider = 'zhipu', apiKey, model, messages, temperature = 0.4 }) {
  const url = ENDPOINTS[provider]
  if (!url) throw new Error(`未知 provider: ${provider}`)
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature }),
      })
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${provider} ${res.status}`); await sleep(700 * (attempt + 1)); continue
      }
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`${provider} 请求失败 ${res.status}: ${txt.slice(0, 150)}`)
      }
      const data = await res.json()
      return parseAction(data.choices?.[0]?.message?.content ?? '')
    } catch (e) {
      lastErr = e
      if (attempt < 3) await sleep(600 * (attempt + 1)) // 网络类错误也重试
    }
  }
  throw lastErr
}

// 从模型输出里稳健地抽出第一个 JSON 对象（有些模型会多嘴）
function parseAction(raw) {
  let text = raw.trim()
  // 去掉可能的 ```json ``` 包裹
  text = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) {
    return { action: 'say', args: { text: '（我没太听懂，可以换种说法吗）' } }
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    if (!obj.action) throw new Error('缺少 action')
    if (!obj.args) obj.args = {}
    return obj
  } catch (e) {
    return { action: 'say', args: { text: '（我没太听懂，可以换种说法吗）' } }
  }
}

module.exports = { decideAction, callJSON, parseAction }
