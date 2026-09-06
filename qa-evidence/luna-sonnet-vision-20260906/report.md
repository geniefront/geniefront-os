# Luna / Sonnet 开店识图实测

测试日期：2026-09-06。只运行模型 API 和现有纯函数；未修改业务代码、未切换配置、未写数据库。

结论：在这张 SPA 价目表上，Luna medium 与 Sonnet high 均完整识别 28 个收费实体、49 个价格/时长或加项条目。Luna medium 完整结果中位耗时是 Sonnet 的 1/2.74，等待缩短 63.5%。这只证明单图数字提取表现，不代表所有 AI 场景通过。

## 方法

- 原图：`/Users/naiyouzhu/siteadmin/test_image_spa.jpg`，1080×1920，未裁切或增强。
- 使用项目现有 PRICE_LIST_SYSTEM、priceListUserText、priceListToolSchema，强制 record_price_list，输出上限 32000。
- Sonnet：claude-sonnet-5 / high，Anthropic Messages，保持当前项目请求参数。Luna：gpt-5.6-luna / medium、low，OpenAI Responses，图片 detail=high，store=false。不同厂商相同 effort 名称不代表同等算力；比较的是实际候选配置。
- 每配置三次，新对话；配置内串行，两个厂商可重叠；不自动重试，240 秒超时；保留正常缓存。首轮有缓存写入，后两轮命中缓存，详见原始 usage。
- 完整耗时：开始请求到完整工具调用结束，不含网页上传、翻译、数据库写入。首输出：首次函数参数增量，不代表可用完整结果。
- 手工基准见 ground-truth.json，在读取模型回答前根据原图建立；评分脚本分别比较原始输出和现有 normalizeExtraction + mergeDrafts 结果。

## 延迟与数字识别

| 配置 | 次数 | 完整耗时中位数 | 完整耗时范围 | 首输出中位数 | 每次收费实体 | 每次正确价格/时长条目 |
|---|---:|---:|---:|---:|---:|---:|
| sonnet-high | 3 | 91.1s | 90.7–94.0s | 2.9s | 28/28 | 49/49 |
| luna-medium | 3 | 33.3s | 31.4–34.8s | 6.9s | 28/28 | 49/49 |
| luna-low | 3 | 30.9s | 28.2–35.0s | 2.5s | 28/28 | 49/49 |

9/9 响应通过现有 Zod 校验；数值评分中未发现漏价、错价、错时长或多造价格档位。三个 Signature Spa Package 的组成与价格档位均被分开识别。

## 数字评分以外的差异与限制

1. **按人收费语义未可靠保存。** 五个 COUPLES & SPA ADD-ON 价格都有 each，但两模型的加项记录都未结构化保留此单位；现有 schema 没有计价单位/适用范围字段，也未把它稳定保存在 note。Sonnet 有 2/3 次在 unresolved 中提到 each，Luna medium 0/3 次，Luna low 1/3 次。不能把 49/49 写成“完整语义准确率100%”。
2. **套餐次数存在推断。** 图片未印可核销次数，Luna 六次均给三个套餐填 package_sessions=1；Sonnet 三次中两次填1、一次填0。套餐一次性服务和次卡核销次数需要区分；这里不应视为从图上直接读出的事实。
3. **名称逐字忠实度。** Sonnet 第二次输出 Couples Massage (Relaxation)，原图标题是 COUPLES MASSAGE，下方说明确实说价格为 Relaxation Massage。评分将它人工裁定为同一收费实体（见 score.py 明确别名），数字仍正确，但另记 nonVerbatimNames；大小写和弯直撇号不计为数字识别错误。
4. **现有代码造成独立信息丢失。** 9次原始结果都保留了不同分类的 Hot Stone、Aroma Oil、Steam Sauna；mergeDrafts 按 kind+name+主价格去重，忽略 category，导致双人SPA分类的三条消失。合并后只剩25/28收费实体、46/49带分类的条目。这是现有代码问题，不计为模型漏识别。对应 packages/ai/src/normalize.ts 的 mergeDrafts。
5. **未评估项。** bbox定位精度、多张图交叠、模糊/反光/手写、多语言、真实开店端到端延迟、翻译质量、副驾工具执行、报表总结、健康表单等未在本次测试覆盖。只有1张独立图片，重复运行不是9个独立样本；不报告生产P95或泛化准确率。

## 建议

- 在该样本上，Luna medium 是合适的开店识图候选：数字表现与Sonnet一致，完整等待显著减少。low只带来小幅中位时间改善且范围重叠，本轮不足以证明它更稳定。
- 后续可以把“统一采用Luna”作为迁移目标，但本次仅支持识图这一部分；需要补代表性图片及其他AI功能任务验收，才能确认全部替换。
- 切换前应处理计价单位、套餐次数和跨分类误合并，否则换模型仍会损失业务语义。

## 证据文件

- manifest.json：图片/提示词/schema哈希及请求配置。
- ground-truth.json：手工核对表，28实体/49数字条目。
- 各模型 JSON：真实API结果、耗时、usage、结构化提取、现有归一化及合并结果。
- scores.json / summary.json：逐次评分与汇总。
- run.mts / score.py：独立测试与评分脚本；脚本读取项目环境变量但未包含或复制凭据。
