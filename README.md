# MC AI Agent

一个用自然语言指挥的 Minecraft AI 机器人。它作为一个**独立玩家**登录服务器（不是 mod），
听你下的目标，由 LLM **自主拆解、一步步组合技能**去完成，调用 Mineflayer 执行动作。

```
你的目标(聊天/终端) → Agent循环: [看世界状态 → LLM决定下一步 → 执行 → 看结果] 反复 → 直到完成
                                          ↑                                ↓
                                    LLM大脑(智谱/DeepSeek/…)          Mineflayer → 服务器
```

> 支持 LLM：智谱 GLM（免费，国内直连，默认）/ DeepSeek / OpenRouter / Google Gemini，改 `config.json` 一行即可切换。

## 一次性准备

### 1. 装 Node 依赖（需 Node 18+）
```bash
npm install
```

### 2. 配置文件
复制模板，填入你的设置（机器人名、master 游戏ID、用哪个 LLM）：
```bash
cp config.example.json config.json
```

### 3. 配 LLM key
复制 `.env.example` 为 `.env`，按 `config.json` 里选的 provider 填对应的 key：
```bash
cp .env.example .env
```
- 默认用智谱 GLM（免费）：去 https://open.bigmodel.cn/usercenter/apikeys 建 key，填到 `ZHIPU_API_KEY`

### 4.（仅跨版本服需要）装并启动 ViaProxy
如果服务器版本比 Mineflayer 支持的最高版本（≤1.21.11）还新（如 1.21.9+/26.x），需要 ViaProxy 做协议翻译：
1. 下载：https://github.com/ViaVersion/ViaProxy/releases （最新的 `.jar`）
2. 运行：`java -jar ViaProxy-xxx.jar`（需 Java 21+，可 `brew install openjdk@21`）
3. 界面里设置：Target Server = 你服务器地址、Target Version = 服务器版本、Auth = `No account / Offline`、Local Port = `25568`（与 config.json 的 port 一致）
4. 点 **Start** 保持开着。然后把 config.json 的 `host/port` 指向本地 ViaProxy（`127.0.0.1:25568`）。

> 同版本服（Mineflayer 支持的版本）不需要 ViaProxy，config.json 的 host/port 直接填服务器地址即可。

## 运行
```bash
npm start
```
进游戏后，在聊天里发**目标**（简单复杂都行，它会自己拆）：
```
bot 过来
bot 帮我做一把木镐
bot 做一把铁镐          (会自动: 砍树→木板→工具→挖石→挖铁→烧铁→合成)
bot 挖10个煤回来
bot 打那只僵尸
bot 停                  (随时打断当前任务)
```

## 底层技能（27个，Agent 把它们组合起来用）
- 移动：come 过来 / follow 跟随 / goto 去坐标 / explore 远程探索 / mount 上载具 / dismount 下来
- 收集：collect 智能采矿 / mine 挖隧道 / pickup 捡掉落物
- 制作：craft 合成 / smelt 烧炼 / place 放方块
- 物品：inventory 背包 / equip 装备 / armor 穿盔甲 / drop 丢出 / deposit 存箱子 / withdraw 取箱子
- 战斗：attack 攻击一次 / guard 自动战斗模式 / flee 逃跑
- 交互：useBlock 用方块(门/拉杆/按钮) / interact 对实体(剪毛/挤奶/繁殖/交易)
- 生存：eat 吃东西 / fish 钓鱼 / sleep 睡觉 / wake 起床
- 其它：stop 停 / say 说话
另有后台自动运行：**饿了自动吃东西**、**低血量自动逃跑**、**空闲遇敌自动应战**（可在 config.json 用 autoDefense/fleeHealth/autoDefend 开关）。

参考外挂 client 增强的能力（机器人本就拥有已加载区块数据，属合法使用）：
- **collect 智能采矿**：穿墙扫描整片已加载区块找矿(=矿透)、自动装备最佳工具、自动寻路挖路过去
- **寻路增强**：自动挖路、搭桥、立柱、跑酷
- **guard 自动战斗**：持续锁定范围内目标追打。target=mobs打怪/players打除主人外玩家/具体名字。说"停"退出

想加新技能：在 `src/skills.js` 里写个函数，再在 `src/agent.js` 的提示词里登记一行。

## 结构
- `src/index.js` —— 连接 + 聊天监听 + 调度（每条指令交给 Agent）
- `src/agent.js` —— **Agent 循环**：看状态→LLM定下一步→执行→反馈，直到目标完成
- `src/brain.js` —— 调 LLM（智谱/DeepSeek/OpenRouter/Google 可切）
- `src/skills.js` —— 真正干活的动作（调 Mineflayer）
- `config.json` —— 连接/模型/权限/步数上限 配置

## 已知限制
- **不会远程探索**：需要的资源得在身边约 16~64 格内，附近没树/没矿它会卡住（可后续加"探索/找资源"技能）
- glm-4.5-flash 每步约 2 秒，复杂目标几十步，可能要 1~3 分钟，正常现象
- 烧炼较慢（每个约 10 秒）
