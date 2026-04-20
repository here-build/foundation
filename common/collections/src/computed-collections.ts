import type * as mobx from "mobx";
import { computed, type IComputedValueOptions } from "mobx";

export class ComputedWeakMap<K extends WeakKey = WeakKey, V = any> extends WeakMap<K, V> {
  constructor(
    public readonly generator: (key: K) => V,
    public readonly options?: IComputedValueOptions<V>,
  ) {
    super();
  }

  get(key: K): V {
    if (super.has(key)) {
      // @ts-expect-error - stored value is IComputedValue<V>, not V
      return super.get(key)!.get();
    }
    const newValue = computed(() => this.generator(key), this.options);
    // @ts-expect-error - storing IComputedValue<V> as V
    super.set(key, newValue);
    return newValue.get();
  }
}

export class ComputedMap<K, V = any> extends Map<K, V> {
  constructor(
    public readonly generator: (key: K) => V,
    public readonly options?: IComputedValueOptions<V>,
  ) {
    super();
  }

  get(key: K): V {
    if (super.has(key)) {
      // @ts-expect-error - stored value is IComputedValue<V>, not V
      return super.get(key)!.get();
    }
    const newValue = computed(() => this.generator(key), this.options);
    // @ts-expect-error - storing IComputedValue<V> as V
    super.set(key, newValue);
    return newValue.get();
  }
}

export class ComputedUniformMap<K = any, V = any> {
  private readonly weakMap = new WeakMap<WeakKey, mobx.IComputedValue<V>>();
  private readonly map = new Map<K, mobx.IComputedValue<V>>();

  constructor(
    public readonly generator: (key: K) => V,
    public readonly options?: IComputedValueOptions<V>,
  ) {}

  has(key: K): boolean {
    return this.isWeakKey(key) ? this.weakMap.has(key) : this.map.has(key);
  }

  get(key: K): V {
    if (this.has(key)) {
      const computedValue = this.isWeakKey(key) ? this.weakMap.get(key)! : this.map.get(key)!;
      return computedValue.get();
    }

    const newValue = computed(() => this.generator(key), this.options);
    if (this.isWeakKey(key)) {
      this.weakMap.set(key, newValue);
    } else {
      this.map.set(key, newValue);
    }
    return newValue.get();
  }

  delete(key: K): boolean {
    return this.isWeakKey(key) ? this.weakMap.delete(key) : this.map.delete(key);
  }

  private isWeakKey(key: K): key is K & WeakKey {
    return typeof key === "object" && key !== null;
  }
}
