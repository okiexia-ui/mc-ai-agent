require('dotenv').config()
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { registerSkills, initAutoEat, nearestThreat } = require('./skills')
const { runGoal } = require('./agent')

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))
const provider = config.provider || 'zhipu'
const KEY_ENV = {
  zhipu: 'ZHIPU_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}
const need = KEY_ENV[provider]
const API_KEY = process.env[need]

if (!API_KEY) {
  console.error(`❌ provider=${provider} 但 .env 里没找到 ${need}。请填好再启动。`)
  process.exit(1)
}

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  version: config.version,
  auth: 'offline', // 盗版/离线服
})

bot.loadPlugin(pathfinder)

let skills
let activeGoal = null // 当前正在跑的目标 { abort: bool, promise }
const llm = { provider, apiKey: API_KEY, model: config.model, maxSteps: config.maxSteps || 25 }

// 启动一个目标；若已有目标在跑，先打断它再开始新的
async function startGoal(username, text) {
  if (activeGoal) {
    activeGoal.abort = true
    skills.stop()
    try { await activeGoal.promise } catch (e) {}
  }
  const g = { abort: false }
  activeGoal = g
  g.promise = runGoal({
    bot, skills, llm,
    goal: text,
    speaker: username,
    say: (msg) => { if (!g.abort) bot.chat(String(msg).slice(0, 200)) },
    log: (msg) => console.log('  ' + msg),
    shouldStop: () => g.abort,
  })
  try { await g.promise } catch (e) {
    console.error('处理出错:', e.message)
    if (!g.abort) bot.chat('（出错了：' + e.message.slice(0, 80) + '）')
  } finally {
    if (activeGoal === g) activeGoal = null
  }
}

// 统一的指令分发：游戏聊天 和 终端 都走这里
function dispatch(speaker, text, fromTerminal) {
  if (!skills) { console.log('（机器人还没进服，稍等）'); return }
  if (/^(停|停下|停止|stop|别动|住手)$/i.test(text)) {
    if (activeGoal) activeGoal.abort = true
    skills.stop()
    const msg = '停下了'
    fromTerminal ? console.log(msg) : bot.chat(msg)
    return
  }
  startGoal(speaker, text) // 新指令自动打断旧目标
}

// 感知自动反应：低血量自动逃跑；空闲时遇敌自动战斗
function initAutoDefense() {
  if (config.autoDefense === false) return
  const fleeHP = config.fleeHealth || 8
  let fleeing = false, defending = false
  setInterval(() => {
    if (!skills || !bot.entity) return
    const threat = nearestThreat(bot, 12)
    // 1) 低血量 + 有威胁 → 打断一切去逃命
    if (bot.health <= fleeHP && threat) {
      if (!fleeing) {
        fleeing = true; defending = false
        console.log('⚠️  低血量，自动逃跑')
        if (activeGoal) activeGoal.abort = true
        bot.chat('血量危险，先撤！')
        skills.flee()
      }
      return
    }
    fleeing = false
    // 2) 空闲 + 健康 + 敌人靠近 → 自动应战
    if (config.autoDefend !== false && !activeGoal && threat && threat.position.distanceTo(bot.entity.position) < 7) {
      if (!defending) { defending = true; console.log('⚔️  遇敌，自动应战'); skills.guard({}) }
    } else if (defending && !threat) {
      defending = false; skills.stop()
    }
  }, 700)
}

bot.once('spawn', () => {
  skills = registerSkills(bot, { masters: config.masters })
  initAutoEat(bot) // 饿了自动吃东西
  initAutoDefense() // 低血逃跑 / 遇敌自卫
  console.log(`✅ 机器人 "${config.username}" 已进入服务器`)
  console.log('⌨️  现在可以直接在这个终端里打字命令它（例如：做一把木镐）。游戏里则用 "bot ..."。')
  bot.chat('AI 机器人上线了，叫我做事吧~')
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return // 忽略自己
  if (config.masters.length > 0 && !config.masters.includes(username)) return // 权限

  let text = message
  if (config.trigger) {
    if (!message.toLowerCase().startsWith(config.trigger.toLowerCase())) return
    text = message.slice(config.trigger.length).trim()
  }
  if (!text) return

  console.log(`📩 [${username}] ${text}`)
  dispatch(username, text, false)
})

// 终端输入：在跑 npm start 的窗口直接打字即可
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  // 终端指令以哪个玩家身份说话（影响"过来/跟着我"指向谁）：默认第一个 master
  const speaker = config.masters[0] || config.username
  console.log(`⌨️  [终端→以 ${speaker} 身份] ${text}`)
  dispatch(speaker, text, true)
})
rl.on('SIGINT', () => process.exit(0)) // 保证 Ctrl+C 仍能退出

bot.on('kicked', (reason) => console.error('被踢:', reason))
bot.on('error', (err) => console.error('错误:', err.message))
bot.on('end', () => console.log('连接断开'))
