// Agent 循环：给一个高层目标，让 LLM 反复"看状态→决定下一步→执行→看结果"，自主组合技能达成目标。
const { callJSON } = require('./brain')

const AGENT_SYSTEM = `你是一个 Minecraft 自主智能体。玩家给你一个目标，你要自己拆解、一步步完成。
每一步你只输出一个 JSON：{"thought":"简短思考","action":"动作名","args":{...},"done":true或false}
- done=true 表示"目标已完成"，循环就此结束；只有简单的一句话指令(如过来、停下)可以一步就 done=true。
- 复杂目标(如做工具、凑材料、盖东西)要 done=false 持续推进，每步根据下面给你的【当前状态】和【已执行步骤的结果】决定下一步。
- 行动失败了(结果里有"失败/没找到/不够")就换思路：缺材料就去采集/挖矿，缺工作台就 place 一个，等等。

可用动作(就是你的工具)：
- come{player} 去玩家身边 / follow{player} 跟随 / goto{x,y,z} 去坐标
- collect{block,count} 采集指定方块(英文ID,会扫描整片已加载区块穿墙找矿、自动用最佳工具寻路过去) / mine{direction,length} 盲挖隧道(forward/down/up)
- craft{item,count} 合成(英文ID,会自动找/需要工作台) / smelt{input,count} 烧炼(矿石/食物,自动找熔炉加燃料)
- place{block} 放方块(默认放身前)
- attack{target} 攻击一次目标(怪名/玩家名/nearest) / guard{target} 进入"自动战斗模式"持续打(target填mobs打怪/players打除主人外玩家/具体名字)
- mount{} 上载具 / dismount{} 下来
- deposit{item,count} 存物品进附近箱子(不填item存全部) / withdraw{item,count} 从箱子取出 / drop{item,count} 丢出物品(给玩家就先come再drop)
- equip{item} 装备/拿出某物品到手或对应槽 / armor{} 穿上/装备整套盔甲护甲(背包已有的,直接用此动作,别去合成) / pickup{} 捡附近掉落物
- useBlock{block} 使用方块(开门/按钮/拉杆,按名找最近或给x,y,z) / interact{target} 对实体用手中物(剪羊毛/挤奶/繁殖/喂食/村民交易)
- fish{} 钓鱼(需鱼竿+对着水) / sleep{} 睡觉(需床+夜晚) / wake{} 起床
- eat{} 吃东西 / inventory{} 看背包 / stop{} 停 / say{text} 说话 / none 啥也不做(仅用于收尾done)

Minecraft 合成常识(供你规划)：
- 原木oak_log →(工作台)4木板oak_planks；2木板→4木棍stick；4木板→工作台crafting_table；8圆石cobblestone→熔炉furnace
- 工具=3材料+2木棍：木镐wooden_pickaxe(用木板)、石镐stone_pickaxe(用圆石cobblestone)、铁镐iron_pickaxe(用铁锭iron_ingot)
- 挖石头stone得到圆石cobblestone(需木镐+)；挖铁矿iron_ore需石镐+；钻石diamond_ore需铁镐+
- 镐的等级很关键！钻石必须用铁镐(iron_pickaxe)及以上才挖得出，石镐挖钻石会破了但啥都不掉=白挖。若 collect 返回"工具不够/挖不动"，就先按链条做出更高级的镐(没铁锭就先挖铁矿→烧铁锭→做铁镐)，再回来挖。
- 重要：铁矿iron_ore要变铁锭iron_ingot必须用 smelt 烧炼(不是craft)！没熔炉就先craft一个furnace(8圆石)再place。烧炼要燃料(煤coal或木板)
- 没工作台/熔炉就先 place 一个(背包里要有)。规划时先看【当前状态】的背包，已有的别重复做。
- 想要某种矿石/方块：先用 collect(它能穿墙扫整片区域找现成的矿)；只有 collect 报"没找到"才用 mine 往下挖到对应高度(钻石约y<16,铁矿y<60)出新区块,再 collect。注意 collect 的 block 必须是方块ID：矿石用 *_ore 形式(如 diamond_ore、iron_ore，不是 diamond、iron)。
- 挖矿石时如果玩家没明确说数量(如"去挖钻石""挖点铁矿")，collect 的 count 用 "all" 把范围内能找到的全挖了；只有玩家明确说了数字(如"挖3个")才用那个数字。

- "穿盔甲/装备盔甲"用 armor(背包有就直接穿,不要craft)；"拿出/装备某物"用 equip。实在不确定该做什么就用 say 反问，别乱选 craft。
- "上船/坐船/骑马"用 mount 去坐附近现成的载具；如果 mount 返回"附近没有载具"，就 say 告诉玩家附近没有，**不要**自作主张去造船/抓马，除非玩家明确说"造一艘船"。
- 别把简单指令过度复杂化：玩家只说"上船"就只 mount，不要展开成一长串合成。

严格只输出那一个 JSON，不要多余文字。`

// 收集当前世界状态，喂给 LLM 当"眼睛"
function observe(bot) {
  const mcData = require('minecraft-data')(bot.version)
  const p = bot.entity.position
  const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || '空'
  const interesting = ['crafting_table', 'furnace', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
    'stone', 'cobblestone', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'water', 'lava']
  const near = []
  for (const name of interesting) {
    const bt = mcData.blocksByName[name]
    if (!bt) continue
    if (bot.findBlocks({ matching: bt.id, maxDistance: 16, count: 1 }).length) near.push(name)
  }
  const players = Object.keys(bot.players).filter(n => n !== bot.username && bot.players[n].entity)
  return `位置:(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}) 生命:${Math.round(bot.health)}/20 饥饿:${Math.round(bot.food)}/20
背包: ${inv}
附近16格有: ${near.join(', ') || '无特别方块'}
附近玩家: ${players.join(', ') || '无'}`
}

// 运行一个目标。say 用于把进度发到游戏聊天，log 打印到控制台。
// shouldStop() 返回 true 时立即中止（被新指令打断或玩家说"停"）。
async function runGoal({ bot, skills, llm, goal, speaker, say, log, shouldStop = () => false }) {
  const steps = []
  for (let i = 0; i < llm.maxSteps; i++) {
    if (shouldStop()) { log('被打断，结束当前目标'); break }
    const obs = observe(bot)
    const stepsText = steps.length
      ? steps.map((s, idx) => `${idx + 1}. ${s.action}(${JSON.stringify(s.args)}) => ${s.result}`).join('\n')
      : '(还没开始)'
    const userMsg = `总目标：${goal}\n下令的玩家：${speaker}\n\n【当前状态】\n${obs}\n\n【已执行步骤】\n${stepsText}\n\n请给出下一步 JSON。`

    let decision
    try {
      decision = await callJSON({ ...llm, messages: [{ role: 'system', content: AGENT_SYSTEM }, { role: 'user', content: userMsg }] })
    } catch (e) {
      if (shouldStop()) break
      log(`LLM 出错: ${e.message}`)
      say(`（大脑出错了：${e.message.slice(0, 60)}）`)
      break
    }

    if (shouldStop()) break // LLM 调用期间被打断，就别执行这个过时动作了
    const { thought, action, args = {}, done } = decision
    log(`步骤${i + 1} 💭${thought || ''} → ${action}(${JSON.stringify(args)})${done ? ' [done]' : ''}`)

    let result = '(无)'
    if (action && action !== 'none') {
      const fn = skills[action]
      if (!fn) result = `未知动作 ${action}`
      else {
        try { result = await fn(args) } catch (e) { result = '执行出错: ' + e.message.slice(0, 60) }
      }
      // 把有意义的结果发到聊天，让玩家看到进展
      if (result && result !== 'ok') say(result)
    }
    steps.push({ action, args, result })

    if (done) break
    // 防卡死：连续 4 步都是同一个动作且结果都不是成功(含"失败/没/不"等)，就停手报告
    if (steps.length >= 4) {
      const last4 = steps.slice(-4)
      const sameAction = last4.every(s => s.action === action)
      const allStuck = last4.every(s => /失败|没|不|出错|超时|undefined/.test(String(s.result)))
      if (sameAction && allStuck) {
        say(`这步「${action}」一直卡住（${String(result).slice(0, 40)}），我先停了，换个说法或帮我挪个位置？`)
        log('检测到卡死循环，提前结束')
        break
      }
    }
    if (i === llm.maxSteps - 1) say(`（步数到上限 ${llm.maxSteps} 了，先停。可以再让我继续）`)
  }
  return steps
}

module.exports = { runGoal, observe }
