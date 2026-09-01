# Hybrid routing workflow: зафиксированное решение и доказательства

Дата фиксации: 2026-08-31, уточнено 2026-09-01

Статус: production workflow реализован в `feat/hybrid-easyeda-wasm-routing`; повторная corpus validation выполняется
Основной scope: EasyEDA Copilot Router, двухслойные платы, KRT 0.21.3 и EasyEDA WASM router

Этот документ фиксирует выводы исследования и фактическую реализацию
Hybrid/KRT workflow. Он заменяет две более ранние рабочие гипотезы: KRT
hard-relations до EasyEDA и исключение hard-special nets из EasyEDA. Поздний
full-corpus A/B показал более устойчивую последовательность: один глобальный
EasyEDA pass по всем routable non-plane nets, selective reset provisional
hard-special copper, затем одна KRT transaction и один условный remaining repair.

## Неподвижные требования

1. Публичные DSL, `RoutingBoard`, backend input/output и host/router контракты не меняются.
2. Не вводится отдельный режим «однослойная плата». Условие Hybrid — не более двух copper layers.
3. Для плат более чем с двумя copper layers основным остаётся full KRT workflow.
4. Любая ошибка или timeout возвращает последний полезный checkpoint как partial result. Уже полезная медь не выбрасывается.
5. EasyEDA WASM запускается с максимально близкими к native default/max-completion настройками.
6. EasyEDA получает сети в исходном native-порядке. Алфавитная сортировка и искусственные веса не применяются.
7. GND/plane nets не передаются обычному maze routing. Ими владеют core copper/plane stages.
8. Generic successful `critical` net не становится автоматически immutable: такая сеть может оказаться blocker.
9. Hard-special copper защищается только после проверки соответствующей семантики.
10. Глобальную дополнительную проверку EasyEDA за самим EasyEDA не добавляем. Проверяем только собственные KRT transactions и hard semantics, которые EasyEDA не умеет гарантировать.

## Зафиксированные границы возможностей

| Intent / сеть | Владелец в обычном двухслойном Hybrid | Fallback |
| --- | --- | --- |
| Ordinary single-ended | EasyEDA WASM | KRT full, если EasyEDA недоступен |
| Обычная diff pair без impedance/length relation | EasyEDA WASM native diff-pair fields | KRT full |
| Matched/length group | EasyEDA provisional corridor, затем KRT final custody | EasyEDA может дать только unverified partial copper |
| Single-ended impedance | EasyEDA provisional corridor, затем KRT native impedance transaction | EasyEDA result помечается impedance-unverified |
| Differential impedance | EasyEDA provisional diff pair, затем KRT `route_diff.py` native impedance transaction | EasyEDA result помечается impedance-unverified |
| PowerNet без иных hard constraints | EasyEDA WASM с effective width/rules | KRT repair, если сеть осталась open |
| Generic critical/high priority или `viaPreference: "avoid"` | EasyEDA WASM; это порядок/стоимость, не hard custody | KRT repair, если сеть осталась open |
| `viaPreference: "forbid"` или per-net layer restriction | EasyEDA provisional corridor, затем KRT final custody | Unverified partial при недоступном KRT |
| Explicit fanout | EasyEDA provisional corridor, затем late KRT transaction, только по явному DSL | Partial без fanout при недоступном KRT |
| GND/planes/polygons | Core/plane workflow | Существующая core partial policy |
| Opens после EasyEDA и KRT victims | Один финальный KRT remaining/repair | Оставить open в partial result |

### EasyEDA и matched length

EasyEDA WASM не поддерживает length constraints. Это не вопрос слоя, веса,
порядка или настройки стоимости. EasyEDA может случайно получить близкие
длины, но не умеет гарантировать matched group. Поэтому members всех matched
groups входят в финальную KRT custody. При этом EasyEDA сначала видит и их:
это помогает глобальному planner оставить реалистичные выходы из pads и
коридоры. Перед KRT только provisional copper этих nets удаляется.

Если KRT недоступен до начала маршрутизации, full EasyEDA fallback может
соединить эти сети, но результат обязан явно оставаться length-unverified.

### Нижние слои matched routing

Нижний слой случайно не запрещён. KRT 0.21.3 на двух слоях использует native
стоимости `F.Cu=1`, `B.Cu=3`. Успешные matched candidates реально содержали
B.Cu tracks и vias. Нет доказательства, что изменение этих native weights
улучшает результат, поэтому их не трогаем без отдельного A/B.

## Двухслойный Hybrid workflow

```text
DSL parse/compile + effective rules + existing core copper
                         |
 EasyEDA native-default global pass по всем non-plane nets
                         |
selective reset unverified KRT-custody copper
 (incoming editable copper этих nets восстанавливается)
                         |
          одна late KRT constrained transaction
       explicit fanout -> impedance -> matched -> main
                         |
     один условный KRT remaining/transactional repair
                         |
      лучший audited checkpoint -> complete или partial
```

### 1. Parse и preflight

Существующая цепочка DSL остаётся без изменений:

1. host компилирует DSL в существующий `RoutingProgram`;
2. core канонизирует board/layers/stackup;
3. source rules, native DRC и DSL intent сливаются в effective rules;
4. core-owned polygons/planes применяются как сейчас;
5. Hybrid заранее проверяет доступность KRT, чтобы выбрать normal или full-EasyEDA fallback scope.

Новых DSL statements, backend fields или host overrides не появляется.

### 2. Один EasyEDA bulk-pass

В normal Hybrid EasyEDA получает все routable non-ground nets:

- ordinary single-ended nets;
- native differential pairs;
- power/critical/high/via-avoid nets;
- provisional matched, impedance, explicit-fanout, via-forbid и
  per-net-layer-constrained nets;
- исходный относительный порядок сетей из EasyEDA board;
- существующие widths, clearances, layers и другие уже поддерживаемые rules.

EasyEDA не получает:

- GND/plane nets;
- ignored nets;
- nets вне resolved route scope или без двух электрических terminals.

Это не означает, что EasyEDA становится владельцем hard semantics. Его copper
для matched/impedance/explicit-fanout nets является временным global-planning
scaffold. Для `via-forbid`/per-net-layer-only nets выполняется дешёвая точная
проверка: нет ли via и лежат ли все tracks/vias/zones только на разрешённых
слоях. Compliant copper сохраняется и передаётся KRT для audit; при любом
нарушении сбрасывается вся provisional copper этой сети. Для reset nets Hybrid
восстанавливает их входной editable copper. Fixed copper не входит в
replacement и никогда не трогается. Если сеть одновременно matched,
impedance или fanout, локальной проверки недостаточно и она всегда reset.

Нельзя дробить bulk на несколько накопительных EasyEDA passes: ранняя медь
становится препятствием для следующего pass и разрушает глобальную оптимизацию
WASM router.

### 3. Explicit fanout

Fanout запускается первым внутри late KRT transaction и только при явном
fanout statement. Его target nets видны EasyEDA provisional pass, но их
EasyEDA copper удаляется перед KRT.
Generic `pre-early`, `early` и `post-early` subprocesses не запускаются.

### 4. Late KRT constrained transaction

После EasyEDA KRT получает полный board/request для правильного audit и blocker
context, но в `post-easy` mode маршрутизирует только final-custody nets и
фактически открытые сети. Порядок по умолчанию:

1. impedance и impedance diff pairs;
2. matched groups;
3. explicit fanout, via-forbid и per-net-layer restrictions;
4. ordinary/diff-pair opens, включая PowerNet, если EasyEDA их не закрыл.

Сеть, одновременно принадлежащая нескольким hard constraints, обрабатывается
атомарно в совместимом batch и проверяется по всем затронутым constraints.

Batch разделяется только по реально несовместимым native KRT параметрам:

- разрешённые layers;
- impedance target/topology/coplanar gap;
- differential gap/geometry;
- width/via/clearance policy;
- matched tolerance.

Это внутреннее планирование. Публичный контракт не меняется.

### 5. Transactional victim repair

Хороший special candidate нельзя ни сразу откатывать из-за ordinary victims,
ни сразу коммитить с повреждённой connectivity.

Правильная transaction:

1. KRT строит candidate для hard-special scope;
2. соответствующая семантика проверяется;
3. определяется точный список ripped/open outside-scope victims;
4. candidate остаётся изолированным;
5. verified hard-special copper защищается;
6. KRT ремонтирует только victims;
7. выполняется combined connectivity/DRC/hard-semantics audit;
8. combined board коммитится атомарно либо целиком откатывается к pre-special EasyEDA checkpoint.

Generic `critical` сам по себе не является hard-special protection. Если более
поздняя hard stage должна изменить уже verified hard-special copper, это новая
joint transaction с повторной проверкой всех затронутых constraints.

### 6. Один final remaining/repair

После constrained transaction допускается один remaining workflow для:

- исходных EasyEDA opens;
- неустранённых victims;
- специальных сетей, которые не удалось завершить, если KRT уже работает.

Дорогой rescue разрешается только здесь и не повторяется внутри каждого
intermediate `route.py`. Основные пределы задаются grid/iterations/search
ladders/числом attempts. Небольшой wall-clock timeout не должен быть главным
ограничителем; outer watchdog нужен только как последняя страховка.

Не повторяются эквивалентные `critical -> main -> monolithic` passes на одном
board/scope/rules/connectivity fingerprint. Cosmetic via repair не запускается,
пока остаются critical opens.

## Fallback policy

### KRT недоступен до EasyEDA

EasyEDA получает full scope, включая diff pairs, matched и impedance nets.
Соединённая медь сохраняется, но unsupported hard semantics отмечается как
unverified и итог остаётся partial.

### KRT упал после EasyEDA

Выбирается лучший безопасный checkpoint между входной платой, уже полученным
EasyEDA result и последним читаемым KRT result. Hard-special semantics явно
помечаются unverified. Новый EasyEDA process специально ради этих opens не
запускается.

### EasyEDA недоступен

Используется общий full KRT workflow. Любой его частичный checkpoint также
возвращается как partial, а не превращается в пустую ошибку.

### Более двух copper layers

Используется full KRT. EasyEDA разрешён только как аварийный full partial
fallback, потому что плотные многослойные платы являются его слабой областью.

## Общая KRT реализация без дублирования

Standalone KRT и Hybrid используют один внутренний runner:

```ts
createKrtWorkflowBackend(options, "full" | "post-easy")
```

- `createKrtBackend()` вызывает `mode: "full"`;
- `createHybridBackend()` владеет только layer policy, EasyEDA partition и fallback;
- Hybrid вызывает тот же KRT runner с `mode: "post-easy"`;
- stage builders, gates, audits, protected ledger и repair не копируются;
- mode является внутренней policy, не новым request/DSL параметром.

## Фактически реализовано

1. На двух слоях Hybrid делает ровно один EasyEDA global pass по всем routable
   non-ground nets. Затем удаляет unverified provisional copper final-custody
   nets, сохраняет compliant via-forbid/layer-only copper, восстанавливает
   incoming editable copper reset-сетей и передаёт checkpoint в общий KRT
   runner с `mode: "post-easy"`.
2. Обычные differential pairs остаются в EasyEDA. Если хотя бы один member
   после EasyEDA открыт, KRT забирает пару целиком; impedance/matched pairs
   всегда остаются в final KRT custody, хотя provisional EasyEDA pass их видит.
3. В full KRT и post-Easy KRT отключены отдельные critical/early subprocesses.
   Priority используется для порядка внутри одного main workflow.
4. Дорогой `net_rescue` разрешён только в одном финальном remaining pass:
   grid `0.1 mm`, до `500000` window cells, одно edge на сеть и до `100000`
   rescue iterations. Dynamic A* ограничен `200000` iterations.
5. Targeted repair имеет не более восьми attempts и общий измеряемый budget
   `15..60 s`; iteration/grid bounds остаются первичным ограничителем.
6. Автоматический bare-pad/BGA escape в rescue выключен. Explicit fanout DSL
   остаётся отдельной стадией и не затрагивается.
7. Любой process/preflight/parse failure сохраняет лучший читаемый checkpoint
   и возвращает `partial`; второй EasyEDA process только ради late opens не
   запускается.
8. Impedance передаётся KRT через native `--impedance`/`--coplanar-gap`,
   физический stackup сериализуется в понятном KRT multiline-виде, а результат
   отдельно оценивается по фактической ширине trunk.
9. В candidate grade добавлен отдельный `impedanceViolationCount`; connectivity
   success больше не маскирует неисполненный impedance intent.
10. EasyEDA synthetic pad carrier всегда остаётся на front side, а физический
    слой задаётся только у pad. Это устраняет double-mirror bottom SMD pads.
11. KRT codec больше не пишет pad-only `thermal_bridge_count/angle` внутрь
    zone fill; все экспортированные validation boards загружаются KiCad 10.

### A/B полного provisional scope против исключения special nets

На всех девяти сохранённых EasyEDA Hybrid cases сравнивались две одинаковые
последовательности. Отличалось только то, видел ли первый EasyEDA pass future
KRT-custody nets. На четырёх реально отличавшихся платах получено:

| Scope EasyEDA | Opens | DRC | Vias | Суммарное время |
| --- | ---: | ---: | ---: | ---: |
| Все routable non-plane nets | 6 | 10 | 212 | 267.3 s |
| Special nets исключены | 7 | 8 | 234 | 267.1 s |

Full provisional scope дал на одну open net и 22 vias меньше без измеримого
штрафа по времени. На `af23609f` оба варианта дали 0 opens/0 DRC, но global
scope использовал 15 vias вместо 26. На `8dcca4bc` global scope дал одну open
net вместо двух и 44 vias вместо 54. Поэтому небольшой DRC trade-off не
устраняется слепым исключением special nets: final KRT gates и native host DRC
остаются acceptance boundary.

Отдельно `b277f943`, ранее тративший около 776 s из-за повторного rescue,
завершил bounded workflow примерно за 74 s с одной open net и одной DRC issue.
Это подтверждает, что основной выигрыш даёт один global planner и один дорогой
remaining ladder, а не повторение близких `critical/main/monolithic` работ.

Полный corpus-отчёт и готовые KiCad artifacts: 
[`docs/validation/hybrid-workflow-20260831.md`](../validation/hybrid-workflow-20260831.md).

## Доказательства matched transaction

### `pcb-dsl-83efabb6`

Исторический exclude-special experiment: EasyEDA default bulk без matched
members, затем late KRT matched и recovery:

- итог: 0 opens;
- 0 matched violations;
- 0 scoped DRC;
- обе matched groups сохранились после recovery.

### `pcb-dsl-8dcca4bc`

Late KRT routed:

- QSPI group: 5/5 nets, spread 5.320 mm при tolerance 8 mm;
- GPIO group: 14/14 nets, spread 6.871 mm при tolerance 8 mm;
- special scope: 19/19 connected.

Отдельный последующий backend invocation потерял protected ledger. Поэтому
special -> victim repair должен жить в одном внутреннем KRT workflow либо
получать ledger явно, а не надеяться на случайный sidecar transfer.

### `pcb-dsl-af23609f`

KRT candidate корректно развёл три matched groups:

- USB_CONN spread 0.467 mm <= 0.5 mm;
- USB_ESD spread 0.260 mm <= 0.5 mm;
- USB_MCU spread 0.064 mm <= 0.5 mm.

Candidate открыл outside-scope `+3V3` и `VBUS`, поэтому текущий outer gate
откатил всю хорошую matched работу. Проверка compound transaction дала:

- victim-only KRT repair: 4.85 s;
- обе victims восстановлены;
- changed protected matched geometry: 0;
- open nets в combined scope: 0;
- scoped DRC: 0.

Это прямое доказательство необходимости atomic special + victim repair.

## EasyEDA defaults и native order

WASM backend уже отправляет `options: {}` и не переопределяет iteration count.
Однако EasyEDA host adapter сейчас строит rules и board nets через алфавитную
`.sort()`. При реализации Hybrid это должно быть исправлено:

1. сначала seed order из native `root.nets`;
2. затем append unseen pad-only nets;
3. для subset filtering сохранять относительный native order;
4. не вводить искусственный net priority/weight.

Один эксперимент не показал разницы между native и alphabetical order, но это
не является основанием переопределять оптимизированный native order на всём corpus.

## Native KRT impedance experiment

Дата: 2026-08-31  
Board: `pcb-dsl-2568fa74`  
Input board SHA-256: `302E59FA2578085746CD3D48F524DDFB85ECB05A435DF4580E2F53BAFD9B951C`  
KRT: production-pinned 0.21.3  
Target nets: `RF_IN`, `RF_IN_IC`, `RF_OUT`, `RF_OUT_IC`  
Intent: 50 ohm grounded coplanar waveguide, F.Cu, GND reference, 0.2 mm side gap  
Stackup: F.Cu 0.03479 mm / FR-4 1.53 mm, Er 4.2 / B.Cu 0.03479 mm

Artifacts находятся в ignored research directory:

`results/research/krt-native-impedance-2568fa74-20260831`

### 1. Обнаружена несовместимость stackup serialization

Copilot KRT codec сериализует весь `(stackup ...)` в одну строку. Text parser
KRT 0.21.3 ищет окончание stackup по newline. На реальном Copilot input KRT
написал:

```text
WARNING: No stackup found in PCB file. Using fixed track width.
```

Флаги были приняты, но все четыре сети проложились штатными 0.3 mm. Для
честного native эксперимента была создана побайтно эквивалентная копия input,
где изменено только форматирование stackup на multiline. После этого parser
увидел F.Cu / FR4_CORE / B.Cu и расчёт включился.

Production prerequisite: либо KRT codec пишет multiline stackup, либо KRT
parser начинает разбирать balanced S-expression без зависимости от newline.

### 2. Формула `--coplanar-gap` действительно работает

На одном и том же распознанном stackup:

| Native flags | Модель | Рассчитанная ширина | KRT verification |
| --- | --- | ---: | ---: |
| `--impedance 50` | Microstrip | 3.0277 mm | 50.0 ohm |
| `--impedance 50 --coplanar-gap 0.2` | CPW-on-GND | 0.8428 mm | 50.1 ohm |

Core ранее рассчитал 0.847 mm. Расхождение с KRT native solve менее 0.5%, то
есть математические модели практически согласованы. Coplanar gap не является
игнорируемым параметром: он радикально меняет выбранную модель и ширину.

### 3. Completion-first route не гарантирует рассчитанную ширину

С default `KICAD_IMPEDANCE_NECKDOWN=1` KRT объявил 4/4 nets routed, 0 vias.
Фактический профиль:

| Net | Полная длина tracks | 0.842773 mm | 0.3 mm | Tapers |
| --- | ---: | ---: | ---: | ---: |
| RF_IN | 12.1509 mm | 6.1669 mm | 4.9840 mm | 1.0000 mm |
| RF_OUT | 12.1509 mm | 6.1669 mm | 4.9840 mm | 1.0000 mm |
| RF_IN_IC | 1.9534 mm | 0 | 1.9534 mm | 0 |
| RF_OUT_IC | 1.9534 mm | 0 | 1.9534 mm | 0 |

То есть native flag правильно вычислил width и построил wide central trunks,
но примерно половина длинных nets и 100% коротких nets не являются 50-ohm
геометрией. Геометрия почти повторила прежний width-only run: native flag сам
по себе не исправляет completion-first neck-down.

### 4. Короткий bounded neck-down заметно улучшает длинные RF nets

Default `--neckdown-length` KRT 0.21.3 равен 2.5 mm с каждого конца. На
12.15 mm route это и создало почти 5 mm узкой геометрии. Контрольный run с
`--neckdown-length 0.5` дал:

| Net | Полная длина tracks | 0.842773 mm | 0.3 mm | Tapers |
| --- | ---: | ---: | ---: | ---: |
| RF_IN | 12.1509 mm | 8.9160 mm | 2.2349 mm | 1.0000 mm |
| RF_OUT | 12.1509 mm | 8.9160 mm | 2.2349 mm | 1.0000 mm |
| RF_IN_IC | 1.9534 mm | 0 | 1.9534 mm | 0 |
| RF_OUT_IC | 1.9534 mm | 0 | 1.9534 mm | 0 |

После real plane refill измеренные RF_IN/RF_OUT улучшились до 52.6 ohm. KiCad
DRC содержал тот же набор из 12 pre-existing board/pad violations, что и
default-neckdown variant; новых track-related violations не появилось.

Это доказывает, что native impedance routing практически полезен для trunk,
если neck-down ограничен. Но short-edge ladder не использует такой tapered
escape: обе короткие 1.95 mm сети по-прежнему стали uniform 0.3 mm и остались
64.5/67.1 ohm. Поэтому одного глобального `--neckdown-length` недостаточно.

### 5. `KICAD_IMPEDANCE_NECKDOWN=0` недостаточно при включённом rescue

При `KICAD_IMPEDANCE_NECKDOWN=0`, но обычном `KICAD_NET_RESCUE=1`, main route
правильно отказался от 0.8428 mm трасс. Затем `net_rescue` восстановил все
четыре сети на fab-floor 0.127 mm, добавив по две vias на сеть, и summary снова
объявил 4/4 success.

При одновременном:

```text
KICAD_IMPEDANCE_NECKDOWN=0
KICAD_NET_RESCUE=0
KICAD_TERMINAL_ESCALATION=0
```

результат стал честным: 0/4 routed, четыре opens. На этой геометрии полный
0.8428 mm route физически не выходит из окружения узких RF/IC pads при 0.2 mm
clearance.

Production prerequisite: rescue обязан сохранять impedance custody. Он не
может понижать width до fab floor и затем считать constraint verified. В
строгом special pass semantic failure должен оставить сеть open; отдельный
completion-first fallback может существовать только как явно unverified partial.

### 6. Реальная plane/coplanar проверка

До заливки GND `check_impedance.py` обнаружил:

- reference-plane crossings: 12;
- length over reference void: 25.891 mm;
- same-layer coplanar ground отсутствует на 100% длины.

Затем KRT `route_planes.py` создал GND zones на F.Cu и B.Cu с
`--zone-clearance 0.2`, KiCad 10 реально refill-нул и сохранил zones, после чего
аудит показал:

- reference-plane crossings: 0;
- length over reference void: 0;
- coplanar gap в tolerance 0.2 +/- 0.05 mm: 56.2% длины;
- gap off-target: 43.8% длины;
- участок без side ground: 0%.

Построенная plane устранила разрывы return path, но не выдержала обещанный
0.2 mm side gap вдоль всей трассы из-за pads/локальной геометрии.

Итоговый post-route impedance audit по фактическим widths и fill при default
2.5 mm neck-down:

| Net | Измеренный Z0 | Ошибка относительно 50 ohm |
| --- | ---: | ---: |
| RF_IN | 59.3 ohm | +18.6% |
| RF_OUT | 59.2 ohm | +18.4% |
| RF_IN_IC | 64.5 ohm | +29.0% |
| RF_OUT_IC | 67.1 ohm | +34.2% |

После bounded 0.5 mm neck-down:

| Net | Измеренный Z0 | Ошибка относительно 50 ohm |
| --- | ---: | ---: |
| RF_IN | 52.6 ohm | +5.2% |
| RF_OUT | 52.6 ohm | +5.2% |
| RF_IN_IC | 64.5 ohm | +29.0% |
| RF_OUT_IC | 67.1 ohm | +34.2% |

В tuned variant matching coplanar gap находился в tolerance на 63.9% общей
длины против 56.2% в default variant. Reference-plane crossings в обоих
filled variants равны нулю.

### 7. Impedance verdict

Флаги KRT `--impedance` и `--coplanar-gap` **действительно работают как width
solver и declaration mechanism**, а bounded neck-down может дать практически
приемлемый 52.6-ohm trunk вместо прежних 59.2--59.3 ohm. На этой реальной
Copilot board они всё же **пока не дают end-to-end гарантированный
controlled-impedance route**: short-edge routing и rescue способны молча
заменить требуемую геометрию обычной/fab-floor шириной.

Состояние production prerequisites после реализации:

1. Stackup serialization и native impedance/coplanar flags исправлены.
2. Impedance special pass не включает generic rescue; любой later ordinary
   fallback повторно проходит impedance audit и остаётся unverified partial.
3. Pad escape отделён от trunk по фактической ширине; короткие сети без wide
   trunk не считаются verified.
4. Connectivity и impedance являются разными candidate dimensions.
5. Impedance batches разделяются по совместимым target/gap/layers/rules.
6. EasyEDA/full ordinary fallback copper сохраняется, но hard semantics явно
   остаётся unverified.
7. Полный field-solver audit реального plane fill всё ещё не встроен в runtime:
   результат выставляет `planeFillFieldSolverVerificationRequired`.

До выполнения этих условий impedance nets остаются KRT-reserved hard-special
scope, но rollout нельзя считать завершённым только на основании того, что
native CLI принял флаги и закрыл connectivity.

## Correctness status и оставшийся риск

1. Exact selector sidecar теперь применяет только полные пары, присутствующие
   в текущем scoped invocation; одиночный unrelated matched member не валит call.
2. Protected ledger живёт внутри compound KRT workflow.
3. Fixed-copper subtraction использует ту же coordinate precision, что codec;
   ложный `ROUTING_FIXED_COPPER_ECHO` устранён.
4. Metrics отдельно показывают `mainMs`, `rescueMs`, `auditMs`, targeted repair,
   число subprocesses и expensive rescues.
5. Известный остаточный риск: length matching KRT происходит до некоторых
   multipoint taps. Финальный semantic audit не даст назвать такую группу
   verified, но отдельный bounded post-tap rematch пока не добавлен.
6. KiCad 10 на нескольких artifacts обнаружил микроскопические dangling
   endpoints, которые tolerant router audit считал соединёнными. До rollout
   exact KiCad connectivity должен оставаться отдельным acceptance signal.

## Что именно считать готовым Hybrid

Rollout для двух слоёв возможен после corpus-проверки, где сравниваются:

1. exact opens/connectivity components;
2. diff/matched/impedance violations;
3. added DRC/shorts;
4. forbidden vias;
5. via count и routed length;
6. wall time p50/p95/max;
7. subprocess count и число expensive rescues;
8. доля rollback к EasyEDA checkpoint;
9. корректный partial result при injected KRT/EasyEDA failures.

Главный принцип: упрощение означает убрать повторную дорогую работу, а не
убрать safety gates. EasyEDA делает один глобальный bulk-route; KRT делает одну
transactional hard-semantics работу и один условный remaining repair; core
сохраняет контракты, checkpoints и partial-result safety.
