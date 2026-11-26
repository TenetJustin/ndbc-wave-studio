import { analysis, phases, validateSimulation } from './science.js';
import { parseFiles } from './input.js';

self.onmessage = ({ data }) => {
  try {
    if (data.kind === 'import') self.postMessage({ value: parseFiles(data.files, data.time) });
    if (data.kind === 'analysis') self.postMessage({ value: analysis(data.record, data.assume) });
    if (data.kind === 'validate') {
      const result = analysis(data.record, data.assume);
      if (!result.direction) throw new Error('运行固定点验证需要方向数据或用户选定的方向假设。');
      self.postMessage({ value: validateSimulation(result.rows, phases(result, data.seed), data.point, data.params) });
    }
  } catch (error) { self.postMessage({ error: error.message || '计算失败' }); }
};
