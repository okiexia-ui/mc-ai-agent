// 技能库：每个技能就是一个调用 Mineflayer 的现成函数。
// 大脑(LLM)只负责挑选技能 + 填参数，真正干活的是这里。
const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const HOSTILE = ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider',
  'creeper', 'enderman', 'witch', 'slime', 'magma_cube', 'pillager', 'vindicator',
  'zombified_piglin', 'piglin', 'blaze', 'phantom', 'silverfish', 'zoglin', 'hoglin']
const RIDEABLE = ['boat', 'chest_boat', 'minecart', 'horse', 'donkey', 'mule', 'pig', 'strider', 'camel', 'llama']
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'] // 从好到差

function registerSkills(bot, opts = {}) {
  const masters = opts.masters || []
  const mcData = require('minecraft-data')(bot.version)
  const foodNames = new Set(Object.values(mcData.foods).map(f => f.name))
  const dist = (e) => e.position.distanceTo(bot.entity.position)
  let guardLoop = null // 自动战斗模式的循环句柄

  // 调强的寻路配置：允许挖路、搭桥、立柱、跑酷
  const makeMovements = () => {
    const m = new Movements(bot)
    m.canDig = true
    m.allow1by1towers = true
    m.allowParkour = true
    m.allowSprinting = true
    return m
  }
  const fresh = () => bot.pathfinder.setMovements(makeMovements())

  // 根据方块自动装备最合适、最高级的工具
  async function equipBestTool(blockName) {
    let toolType
    if (/_ore$|^stone$|^cobblestone$|^deepslate|_block$|furnace|obsidian|netherrack|ancient_debris/.test(blockName)) toolType = 'pickaxe'
    else if (/_log$|_planks$|_wood$|crafting_table|chest|door|fence/.test(blockName)) toolType = 'axe'
    else if (/dirt|grass_block|sand|gravel|clay|soul_sand|mud|podzol/.test(blockName)) toolType = 'shovel'
    else return // 其它方块徒手即可
    const items = bot.inventory.items()
    for (const tier of TOOL_TIERS) {
      const tool = items.find(i => i.name === `${tier}_${toolType}`)
      if (tool) { try { await bot.equip(tool, 'hand') } catch (e) {} ; return }
    }
  }

  // 护甲/装备的目标槽位
  const armorDest = (name) => {
    if (name.endsWith('_helmet') || name === 'turtle_helmet' || name === 'carved_pumpkin') return 'head'
    if (name.endsWith('_chestplate') || name === 'elytra') return 'torso'
    if (name.endsWith('_leggings')) return 'legs'
    if (name.endsWith('_boots')) return 'feet'
    if (name === 'shield' || name === 'totem_of_undying') return 'off-hand'
    return 'hand'
  }
  // 容器/床的方块ID集合（建一次）
  const containerIds = Object.values(mcData.blocksByName)
    .filter(b => ['chest', 'trapped_chest', 'barrel', 'ender_chest'].includes(b.name) || b.name.endsWith('shulker_box')).map(b => b.id)
  const bedIds = Object.values(mcData.blocksByName).filter(b => b.name.endsWith('_bed')).map(b => b.id)
  // 走到某方块旁
  const gotoBlock = async (b, range = 2) => { fresh(); await bot.pathfinder.goto(new goals.GoalNear(b.position.x, b.position.y, b.position.z, range)) }

  // 判断一个实体是不是地上的掉落物（兼容不同版本/ViaProxy 翻译后的命名）
  const itemEntityId = mcData.entitiesByName?.item?.id
  const isDrop = (e) => e && e.isValid && (
    e.name === 'item' || e.objectType === 'Item' || e.displayName === 'Item' ||
    (itemEntityId != null && e.entityType === itemEntityId)
  )
  // 走过去把附近的掉落物吸上来
  const pickupNearby = async (maxDistance = 8, maxItems = 20) => {
    let n = 0
    for (let i = 0; i < maxItems; i++) {
      const drop = bot.nearestEntity(e => isDrop(e) && dist(e) < maxDistance)
      if (!drop) break
      try { fresh(); await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0)); n++ }
      catch (e) { break }
      await new Promise(r => setTimeout(r, 120)) // 等服务器把物品塞进背包
    }
    return n
  }

  const skills = {
    // 走到某个玩家身边
    async come({ player }) {
      const target = bot.players[player]?.entity
      if (!target) return `我看不到玩家 ${player}（太远或不在线）`
      fresh()
      await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2))
      return `已经到 ${player} 身边了`
    },

    // 持续跟随某个玩家
    follow({ player }) {
      const target = bot.players[player]?.entity
      if (!target) return `我看不到玩家 ${player}`
      fresh()
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      return `开始跟随 ${player}`
    },

    // 走到指定坐标
    async goto({ x, y, z }) {
      fresh()
      await bot.pathfinder.goto(new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z)))
      return `到达 ${x} ${y} ${z}`
    },

    // 采集/挖矿：扫描整片已加载区块找方块(相当于"矿透")，自动用最佳工具、自动寻路挖路过去
    // count 传 "all"/0/负数 表示把范围内能找到的全挖了（挖矿石建议用 all）
    async collect({ block, count = 1 }) {
      const blockType = mcData.blocksByName[block]
      if (!blockType) return `我不认识方块 "${block}"（要用英文ID，如 oak_log、stone、diamond_ore）`
      const all = count === 'all' || count === '全部' || Number(count) <= 0 || Number.isNaN(Number(count))
      const cap = all ? 512 : Number(count) // all 模式给个安全上限，防止极端情况挖太久
      let got = 0
      const tried = new Set()
      for (let i = 0; i < cap; i++) {
        // findBlocks 一次取多个最近的，按距离逐个尝试（机器人能"看穿"墙找到矿）
        const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 128, count: 30 })
          .filter(p => !tried.has(`${p.x},${p.y},${p.z}`))
        if (positions.length === 0) break
        const target = positions[0]
        tried.add(`${target.x},${target.y},${target.z}`)
        await equipBestTool(block)
        fresh()
        try {
          await bot.pathfinder.goto(new goals.GoalGetToBlock(target.x, target.y, target.z))
          const b = bot.blockAt(target)
          if (b && b.name === block) {
            // 关键：检查当前工具挖了会不会掉东西（如石镐挖钻石=破了但不掉）
            if (!b.canHarvest(bot.heldItem ? bot.heldItem.type : null)) {
              return got > 0
                ? `采集了 ${got} 个 ${block}，但工具不够挖不出更多（${block} 需要更高级的镐，请先做把更好的镐）`
                : `挖不动 ${block}：当前工具挖了也不掉落，需要更高级的镐（如钻石需铁镐、铁矿需石镐）。先做把合适的镐再来。`
            }
            await bot.dig(b); got++
            await new Promise(r => setTimeout(r, 200)) // 等掉落物出现
            await pickupNearby(5) // 走过去吸起来
          }
        } catch (e) { /* 这个够不着就换下一个 */ }
      }
      await pickupNearby(8) // 收尾再吸一遍周围漏掉的
      return got > 0 ? `采集了 ${got} 个 ${block}` : `整片区域没找到 ${block}（可能附近真没有）`
    },

    // 挖矿/挖隧道：向 forward(前)/down(下)/up(上) 挖 length 格
    async mine({ direction = 'forward', length = 10 }) {
      fresh()
      const yaw = bot.entity.yaw
      const stepOf = {
        forward: new Vec3(-Math.round(Math.sin(yaw)), 0, -Math.round(Math.cos(yaw))),
        down: new Vec3(0, -1, 0),
        up: new Vec3(0, 1, 0),
      }
      const step = stepOf[direction] || stepOf.forward
      let dug = 0
      for (let i = 0; i < length; i++) {
        const base = bot.entity.position.floored().plus(step)
        // 前进隧道挖2格高(脚+头)，上下挖只挖那一格
        const targets = direction === 'forward' ? [base, base.offset(0, 1, 0)] : [base]
        for (const p of targets) {
          const b = bot.blockAt(p)
          if (b && b.name !== 'air' && b.name !== 'bedrock' && b.diggable) {
            // 危险检查：向下挖时如果下方是岩浆/水就停
            if (direction === 'down' && ['lava', 'water'].includes(b.name)) return `下方是 ${b.name}，危险，停止挖矿（已挖 ${dug} 个）`
            await equipBestTool(b.name)
            try { await bot.dig(b); dug++ } catch (e) {}
          }
        }
        try { await bot.pathfinder.goto(new goals.GoalBlock(base.x, base.y, base.z)) } catch (e) { break }
      }
      await pickupNearby(8) // 吸起隧道里挖出的掉落物
      return `挖了 ${dug} 个方块（${direction} 方向）`
    },

    // 合成物品（自动找附近工作台）
    async craft({ item, count = 1 }) {
      const itemType = mcData.itemsByName[item]
      if (!itemType) return `我不认识物品 "${item}"（要用英文ID，如 oak_planks、stick、chest）`
      let table = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 6 })
      let recipes = bot.recipesFor(itemType.id, null, count, table)
      if (recipes.length === 0) {
        // 试着找远一点的工作台并走过去
        const far = bot.findBlock({ matching: mcData.blocksByName.crafting_table?.id, maxDistance: 48 })
        if (far) {
          fresh()
          await bot.pathfinder.goto(new goals.GoalNear(far.position.x, far.position.y, far.position.z, 2))
          table = far
          recipes = bot.recipesFor(itemType.id, null, count, table)
        }
      }
      if (recipes.length === 0) return `没法合成 ${item}（材料不够，或需要工作台但附近没有）`
      try { await bot.craft(recipes[0], count, table); return `合成了 ${count} 个 ${item}` }
      catch (e) { return `合成 ${item} 失败：${e.message.slice(0, 60)}` }
    },

    // 烧炼：把矿石/食物放熔炉烧（自动找熔炉、加燃料、取产物）
    async smelt({ input, count = 1 }) {
      const inType = mcData.itemsByName[input]
      if (!inType) return `不认识物品 "${input}"`
      const inputItem = bot.inventory.items().find(i => i.name === input)
      if (!inputItem) return `背包里没有 ${input}`
      let fb = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 6 })
      if (!fb) {
        const far = bot.findBlock({ matching: mcData.blocksByName.furnace?.id, maxDistance: 48 })
        if (!far) return '附近没有熔炉（先 place 一个 furnace）'
        fresh(); await bot.pathfinder.goto(new goals.GoalNear(far.position.x, far.position.y, far.position.z, 2)); fb = far
      } else {
        fresh(); await bot.pathfinder.goto(new goals.GoalNear(fb.position.x, fb.position.y, fb.position.z, 2))
      }
      const fuel = bot.inventory.items().find(i => ['coal', 'charcoal'].includes(i.name))
        || bot.inventory.items().find(i => i.name.endsWith('_planks') || i.name.endsWith('_log'))
      if (!fuel) return '没有燃料（需要 coal/charcoal/木板/原木）'
      const n = Math.min(count, inputItem.count)
      let furnace
      try {
        furnace = await bot.openFurnace(fb)
        await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.ceil(n / 8) + 1))
        await furnace.putInput(inType.id, null, n)
        let got = 0
        const deadline = Date.now() + n * 11000 + 12000
        while (got < n && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 2000))
          if (furnace.outputItem()) { const o = await furnace.takeOutput(); if (o) got += o.count }
        }
        furnace.close()
        return got > 0 ? `烧出了 ${got} 个产物` : '烧制超时，没拿到产物'
      } catch (e) { try { furnace && furnace.close() } catch (_) {} ; return '烧制失败：' + e.message.slice(0, 50) }
    },

    // 攻击：可打玩家(PvP)、指定怪物，或不填打最近的敌对怪
    async attack({ target } = {}) {
      let entity, name
      // 1) 先看是不是在线玩家(PvP)
      if (target && bot.players[target]?.entity) { entity = bot.players[target].entity; name = target }
      // 2) 指定种类的怪
      if (!entity && target && target !== 'nearest') {
        entity = bot.nearestEntity(e => e.name === target && dist(e) < 32); if (entity) name = entity.name
      }
      // 3) 最近的敌对怪
      if (!entity) {
        entity = bot.nearestEntity(e => e.type === 'mob' && HOSTILE.includes(e.name) && dist(e) < 32); if (entity) name = entity.name
      }
      if (!entity) return target ? `附近没找到 ${target}` : '附近没有可攻击的目标'
      // 装备武器(剑优先, 其次斧)
      const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe'))
      if (weapon) { try { await bot.equip(weapon, 'hand') } catch (e) {} }
      fresh()
      return await new Promise((resolve) => {
        const stop = (msg) => { clearInterval(loop); clearTimeout(timer); bot.pathfinder.setGoal(null); resolve(msg) }
        const loop = setInterval(() => {
          if (!entity.isValid) return stop(`击杀了 ${name}`)
          bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
          if (dist(entity) < 3.5) { try { bot.attack(entity) } catch (e) {} }
        }, 400)
        const timer = setTimeout(() => stop(entity.isValid ? `打了一会 ${name} 没打死，先停了` : `击杀了 ${name}`), 25000)
      })
    },

    // 放方块：不填坐标就自动在身边找一块合适的空地放下
    async place({ block, x, y, z } = {}) {
      // 没指定方块名时，默认放背包里第一个"可放置"的工具方块(furnace/crafting_table/chest)，否则报错让大脑补名字
      if (!block) {
        const guess = bot.inventory.items().find(i => ['furnace', 'crafting_table', 'chest'].includes(i.name))
        if (guess) block = guess.name
        else return '要放哪个方块？请指定 block'
      }
      const item = bot.inventory.items().find(i => i.name === block)
      if (!item) return `背包里没有 ${block}`
      await bot.equip(item, 'hand')

      // 候选放置点：指定坐标优先；否则扫身边一圈地面，找"目标位是空气、下方是实心、且不挡住自己"的位置
      const candidates = []
      const botFeet = bot.entity.position.floored()
      if (x !== undefined && y !== undefined && z !== undefined) {
        candidates.push(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
      } else {
        for (const dy of [0, 1, -1]) {
          for (const dx of [1, -1, 0, 2, -2]) {
            for (const dz of [0, 1, -1, 2, -2]) {
              if (dx === 0 && dz === 0) continue
              candidates.push(botFeet.offset(dx, dy, dz))
            }
          }
        }
      }
      for (const pos of candidates) {
        const targetBlock = bot.blockAt(pos)
        const ref = bot.blockAt(pos.offset(0, -1, 0))
        // 目标位必须可替换(空气/草等)，下方必须实心，且不能是机器人自己站的位置
        const occupiedBySelf = pos.equals(botFeet) || pos.equals(botFeet.offset(0, 1, 0))
        if (occupiedBySelf) continue
        if (!targetBlock || !['air', 'cave_air', 'short_grass', 'tall_grass', 'snow'].includes(targetBlock.name)) continue
        if (!ref || ref.boundingBox !== 'block') continue // 下方必须是实心方块
        try {
          fresh()
          await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
          await bot.equip(item, 'hand')
          await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
          await bot.placeBlock(ref, new Vec3(0, 1, 0))
          return `放置了 ${block}`
        } catch (e) { /* 这个点不行，换下一个 */ }
      }
      return `放置 ${block} 失败：身边找不到合适的空地（站到开阔点的地面再试）`
    },

    // 吃东西（不填就吃背包里第一种食物）
    async eat({ food } = {}) {
      const item = bot.inventory.items().find(i => food ? i.name === food : foodNames.has(i.name))
      if (!item) return food ? `背包里没有 ${food}` : '背包里没有吃的'
      try { await bot.equip(item, 'hand'); await bot.consume(); return `吃了 ${item.name}` }
      catch (e) { return `吃东西失败：${e.message.slice(0, 60)}` }
    },

    // 乘坐载具（船/矿车/马等）
    async mount({ target } = {}) {
      const wanted = target && target !== 'nearest' ? [target] : RIDEABLE
      const entity = bot.nearestEntity(e => wanted.includes(e.name) && dist(e) < 10)
      if (!entity) return '附近10格内没有可乘坐的载具（船/矿车/马等）'
      fresh()
      await bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1))
      bot.mount(entity)
      return `上了 ${entity.name}`
    },

    // 从载具上下来
    dismount() {
      bot.dismount()
      return '下来了'
    },

    // 把物品存进附近的箱子/容器（不填 item 则存全部）
    async deposit({ item, count } = {}) {
      const cb = bot.findBlock({ matching: containerIds, maxDistance: 32 })
      if (!cb) return '附近没有箱子/容器'
      await gotoBlock(cb)
      let cont
      try {
        cont = await bot.openContainer(cb)
        if (!item) {
          let n = 0
          for (const it of bot.inventory.items()) { try { await cont.deposit(it.type, null, it.count); n += it.count } catch (e) {} }
          cont.close(); return n ? `存入了 ${n} 个物品` : '没东西可存'
        }
        const itType = mcData.itemsByName[item]
        if (!itType) { cont.close(); return `不认识物品 ${item}` }
        const have = bot.inventory.items().filter(i => i.name === item).reduce((a, b) => a + b.count, 0)
        if (!have) { cont.close(); return `背包没有 ${item}` }
        const c = count ? Math.min(count, have) : have
        await cont.deposit(itType.id, null, c); cont.close(); return `存入 ${c} 个 ${item}`
      } catch (e) { try { cont && cont.close() } catch (_) {} ; return '存放失败：' + e.message.slice(0, 40) }
    },

    // 从附近的箱子/容器取出物品
    async withdraw({ item, count } = {}) {
      if (!item) return '要指定取哪个物品'
      const itType = mcData.itemsByName[item]
      if (!itType) return `不认识物品 ${item}`
      const cb = bot.findBlock({ matching: containerIds, maxDistance: 32 })
      if (!cb) return '附近没有箱子/容器'
      await gotoBlock(cb)
      let cont
      try {
        cont = await bot.openContainer(cb)
        const avail = cont.containerItems().filter(i => i.name === item).reduce((a, b) => a + b.count, 0)
        if (!avail) { cont.close(); return `箱子里没有 ${item}` }
        const c = count ? Math.min(count, avail) : avail
        await cont.withdraw(itType.id, null, c); cont.close(); return `取出 ${c} 个 ${item}`
      } catch (e) { try { cont && cont.close() } catch (_) {} ; return '取出失败：' + e.message.slice(0, 40) }
    },

    // 丢出物品（玩家可捡，常用于"给某人东西"，可先 come 再 drop）
    async drop({ item, count } = {}) {
      if (!item) return '要指定丢哪个物品'
      const it = bot.inventory.items().find(i => i.name === item)
      if (!it) return `背包没有 ${item}`
      const itType = mcData.itemsByName[item]
      try { await bot.toss(itType.id, null, count ? Math.min(count, it.count) : it.count); return `丢出了 ${item}` }
      catch (e) { return '丢弃失败：' + e.message.slice(0, 40) }
    },

    // 装备物品（护甲自动穿到对应部位，其它拿手上）
    async equip({ item }) {
      const it = bot.inventory.items().find(i => i.name === item)
      if (!it) return `背包没有 ${item}`
      const dest = armorDest(item)
      try { await bot.equip(it, dest); return `装备了 ${item}` } catch (e) { return '装备失败：' + e.message.slice(0, 40) }
    },

    // 穿上背包里最好的整套护甲
    async armor() {
      const tiers = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
      let n = 0
      for (const slot of ['_helmet', '_chestplate', '_leggings', '_boots']) {
        for (const tier of tiers) {
          const it = bot.inventory.items().find(i => i.name === tier + slot)
          if (it) { try { await bot.equip(it, armorDest(it.name)); n++ } catch (e) {} ; break }
        }
      }
      return n ? `穿上了 ${n} 件护甲` : '背包里没有护甲'
    },

    // 捡起附近的掉落物
    async pickup({ range = 32 } = {}) {
      const n = await pickupNearby(range, 40)
      return n > 0 ? `捡了 ${n} 处掉落物` : '附近没有掉落物'
    },

    // 使用方块：开门/按按钮/拉拉杆/开箱外的交互等（按方块名找最近的，或给坐标）
    async useBlock({ block, x, y, z } = {}) {
      let b
      if (x !== undefined && y !== undefined && z !== undefined) b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
      else if (block) { const bt = mcData.blocksByName[block]; if (bt) b = bot.findBlock({ matching: bt.id, maxDistance: 16 }) }
      if (!b) return `没找到要使用的方块 ${block || ''}`
      await gotoBlock(b)
      try { await bot.activateBlock(b); return `使用了 ${b.name}` } catch (e) { return '使用失败：' + e.message.slice(0, 40) }
    },

    // 对实体使用手中物品：剪羊毛/挤奶/繁殖/给狗喂食/和村民交易等（target填实体名或玩家名）
    async interact({ target } = {}) {
      const e = target
        ? bot.nearestEntity(x => (x.name === target || x.username === target) && dist(x) < 16)
        : bot.nearestEntity(x => x.type !== 'player' && dist(x) < 8)
      if (!e) return `附近没有 ${target || '可交互实体'}`
      await gotoBlock({ position: e.position })
      try { await bot.useOn(e); return `对 ${e.name || e.username} 使用了手中物品` } catch (err) { return '交互失败：' + err.message.slice(0, 40) }
    },

    // 钓鱼（需要鱼竿，且对着水）
    async fish() {
      const rod = bot.inventory.items().find(i => i.name === 'fishing_rod')
      if (!rod) return '背包里没有鱼竿'
      try { await bot.equip(rod, 'hand'); await bot.fish(); return '钓到了一条' } catch (e) { return '钓鱼失败（要对着水）：' + e.message.slice(0, 40) }
    },

    // 睡觉（找附近的床；需要夜晚或雷暴）
    async sleep() {
      const bed = bot.findBlock({ matching: bedIds, maxDistance: 16 })
      if (!bed) return '附近没有床'
      await gotoBlock(bed)
      try { await bot.sleep(bed); return '睡下了' } catch (e) { return '睡觉失败（白天/有怪？）：' + e.message.slice(0, 40) }
    },

    // 起床
    wake() { bot.wake().catch(() => {}); return '醒了' },

    // 自动战斗模式：持续锁定并攻击范围内目标（说"停"结束）
    // target: 不填/"mobs"=敌对怪; "players"=除主人外的玩家; 也可填具体名字
    guard({ target } = {}) {
      if (guardLoop) clearInterval(guardLoop)
      // 先装武器
      const weapon = bot.inventory.items().find(i => i.name.endsWith('_sword')) || bot.inventory.items().find(i => i.name.endsWith('_axe'))
      if (weapon) bot.equip(weapon, 'hand').catch(() => {})
      const pick = () => {
        if (target && bot.players[target]?.entity && dist(bot.players[target].entity) < 16) return bot.players[target].entity
        if (target === 'players') return bot.nearestEntity(e => e.type === 'player' && e.username !== bot.username && !masters.includes(e.username) && dist(e) < 16)
        return bot.nearestEntity(e => e.type === 'mob' && HOSTILE.includes(e.name) && dist(e) < 16)
      }
      bot.pathfinder.setMovements(makeMovements())
      guardLoop = setInterval(() => {
        const e = pick()
        if (!e) { bot.pathfinder.setGoal(null); return }
        bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
        if (dist(e) < 3.5) { try { bot.attack(e) } catch (_) {} }
      }, 350)
      const what = target === 'players' ? '玩家' : (target && target !== 'mobs' ? target : '敌对怪物')
      return `进入自动战斗模式，目标：${what}（说"停"结束）`
    },

    // 停止当前移动（也退出自动战斗）
    stop() {
      if (guardLoop) { clearInterval(guardLoop); guardLoop = null }
      bot.pathfinder.setGoal(null)
      return '停下了'
    },

    // 报告背包
    inventory() {
      const items = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ')
      return items || '背包是空的'
    },

    // 在聊天里说话
    say({ text }) {
      bot.chat(String(text).slice(0, 200))
      return 'ok'
    },
  }

  return skills
}

// 自动吃东西回血：饿了(<=17)且背包有吃的就自动吃
function initAutoEat(bot) {
  const mcData = require('minecraft-data')(bot.version)
  const foodNames = new Set(Object.values(mcData.foods).map(f => f.name))
  let eating = false
  bot.on('health', async () => {
    if (eating || bot.food > 17) return
    const item = bot.inventory.items().find(i => foodNames.has(i.name))
    if (!item) return
    eating = true
    try { await bot.equip(item, 'hand'); await bot.consume() } catch (e) {}
    eating = false
  })
}

module.exports = { registerSkills, initAutoEat }
