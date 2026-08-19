import type { Plugin } from '@specter-core/contracts';

export class PluginRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRegistryError';
  }
}

/**
 * 插件注册表：负责依赖拓扑排序与重复检测。
 * 插件间通过 dependsOn 声明依赖，Kernel 保证按依赖顺序执行 setup/start。
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, Plugin>();

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new PluginRegistryError(`Plugin "${plugin.id}" already registered`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id);
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  /** 按 dependsOn 拓扑排序；存在循环依赖或缺失依赖时抛出 */
  order(): Plugin[] {
    const list = this.list();
    const visited = new Map<string, 0 | 1 | 2>();
    const result: Plugin[] = [];

    const visit = (plugin: Plugin, path: string[]): void => {
      const state = visited.get(plugin.id) ?? 0;
      if (state === 2) return;
      if (state === 1) {
        throw new PluginRegistryError(
          `Circular plugin dependency: ${[...path, plugin.id].join(' -> ')}`,
        );
      }
      visited.set(plugin.id, 1);
      for (const dep of plugin.dependsOn ?? []) {
        const depPlugin = this.plugins.get(dep);
        if (!depPlugin) {
          throw new PluginRegistryError(
            `Plugin "${plugin.id}" depends on missing plugin "${dep}"`,
          );
        }
        visit(depPlugin, [...path, plugin.id]);
      }
      visited.set(plugin.id, 2);
      result.push(plugin);
    };

    for (const plugin of list) visit(plugin, []);
    return result;
  }
}