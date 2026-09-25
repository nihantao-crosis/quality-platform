/** vitest 全局装配:每个用例后自动卸载 React 树(双审 P3:此前无 setupFiles,RTL 自动 cleanup 失效)。 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
