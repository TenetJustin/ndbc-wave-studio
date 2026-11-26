# 海况实验室 · Wave Studio

NOAA NDBC 41046 海浪谱交互实验工作台。浏览器内运行一维谱拟合、MEM 方向重建、Three.js 成分波模拟与固定点检验。支持 CSV 和同站同年 NDBC 文件组，输出 PNG、CSV 与可回读实验 JSON。

## 使用工作台

- 实景模式用光照、细纹和大气表现观测谱生成的近场海面。高程模式展示 320 m × 320 m 的定量网格。渲染外观与域外远景独立于固定点统计。
- 点选波面或输入坐标设定测点。点击右侧高程曲线可跳转时间，也可在曲线上用方向键按 0.25 s 移动。
- 将当前实验设为基准，切换观测案例后进入实验对照，可叠加原始频率网格上的观测谱、核对带单位的指标差值、导出 CSV，亦可恢复基准的观测、测点、随机种子和检验设置。基准保存在当前浏览器。

## 本地运行和 GitHub Pages

```sh
npm test
npm run build
npm run preview
```

需要 Node.js 22 或更新版本。Three.js r180 及 OrbitControls 随源码固定提供，见 `vendor/THREE-LICENSE.txt`。无需安装 Node 依赖。生成结果在 `dist/`，全部资源使用相对路径。Pages 发布源选择 GitHub Actions，仓库默认分支的工作流负责测试、构建及部署。

## 方法与口径

- [NOAA NDBC 历史档案](https://www.ndbc.noaa.gov/historical_data.shtml)。内置三个 2025 年观测时次，配套方向来自 NOAA 的 `swdir`、`swdir2`、`swr1`、`swr2`。波谱时间线为每日最大值，另标出三个代表时次。历史数据按 UTC 对齐。项目规定的 `0.020 Hz` 频带剔除，NDBC 缺测频带按原频率网格计算有效能量。
- [ITTC 双参数谱](https://www.ittc.info/media/1309/75-02-07-021.pdf)。处理频率区间内按离散带宽计算谱矩，JONSWAP 使用 γ=3.3 并按输入谱 m₀ 归一。
- [MEM](https://doi.org/10.1175/1520-0485(1986)016%3C2052:MEEOTD%3E2.0.CO;2)。方向用东为 0° 的逆时针传播去向表示，离散 48 个方向。可辨识但缺少个别方向参数的频带采用均匀补齐。固定点统计使用全成分，渲染选取部分能量最高的成分并逐案例标明能量保留比例。
- [Welch](https://doi.org/10.1109/TAU.1967.1161901)。固定种子复现，默认 4 小时稳定海况，去均值、Hann 窗，分段重叠 50%。瑞利 KS 用于近似诊断，原课程记录与浏览器复算分别标注。
- 岸线数据来自 [Natural Earth 公共领域地理数据](https://www.naturalearthdata.com/about/terms-of-use/)。波面首帧为课程项目模拟计算图。

### CSV 输入

必需字段为 `frequency_hz,spectrum_m2_per_hz`。可带 `bandwidth_hz` 和方向字段 `alpha1_deg,alpha2_deg,r1,r2`。角度使用 NDBC 来向约定。`r1,r2` 约定为 0–1。按 100 倍存储时，改用 `r1_scaled_100,r2_scaled_100`。可用 `public/data/example-spectrum.csv` 试导入。用户上传的数据在浏览器内解析、计算及保存。

### 浏览器路径

以 `?renderer=2d` 打开工作台可人工验证二维降级。切换深浅主题后保持数据、结果与视角。GitHub Pages 默认不提供基于服务器的历史记录，凭导出的实验 JSON 可以跨浏览器恢复。
