/**
 * Memory Profiling Utilities for Performance Testing
 *
 * Provides tools for measuring memory usage, GC pressure, and object lifecycle
 * during plexus vs MobX performance comparisons.
 */

// Memory measurement types
export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
}

export interface MemoryProfile {
  name: string;
  snapshots: MemorySnapshot[];
  startTime: number;
  endTime: number;
  peakHeapUsed: number;
  heapGrowth: number;
  averageHeapUsed: number;
}

export class MemoryProfiler {
  private profiles = new Map<string, MemoryProfile>();
  private currentProfile: MemoryProfile | null = null;
  private intervalId: NodeJS.Timeout | null = null;

  /**
   * Start profiling memory usage for a named test
   */
  start(testName: string, samplingIntervalMs: number = 10): void {
    if (this.currentProfile) {
      throw new Error(`Already profiling test: ${this.currentProfile.name}`);
    }

    const startSnapshot = this.takeSnapshot();

    this.currentProfile = {
      name: testName,
      snapshots: [startSnapshot],
      startTime: startSnapshot.timestamp,
      endTime: 0,
      peakHeapUsed: startSnapshot.heapUsed,
      heapGrowth: 0,
      averageHeapUsed: 0
    };

    // Take periodic snapshots
    this.intervalId = setInterval(() => {
      if (this.currentProfile) {
        const snapshot = this.takeSnapshot();
        this.currentProfile.snapshots.push(snapshot);
        this.currentProfile.peakHeapUsed = Math.max(this.currentProfile.peakHeapUsed, snapshot.heapUsed);
      }
    }, samplingIntervalMs);
  }

  /**
   * Stop profiling and return the complete profile
   */
  stop(): MemoryProfile | null {
    if (!this.currentProfile) {
      return null;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const endSnapshot = this.takeSnapshot();
    this.currentProfile.snapshots.push(endSnapshot);
    this.currentProfile.endTime = endSnapshot.timestamp;

    // Calculate metrics
    const startHeap = this.currentProfile.snapshots[0].heapUsed;
    const endHeap = endSnapshot.heapUsed;
    this.currentProfile.heapGrowth = endHeap - startHeap;

    this.currentProfile.averageHeapUsed =
      this.currentProfile.snapshots.reduce((sum, snap) => sum + snap.heapUsed, 0) /
      this.currentProfile.snapshots.length;

    const profile = this.currentProfile;
    this.profiles.set(profile.name, profile);
    this.currentProfile = null;

    return profile;
  }

  /**
   * Take an immediate memory snapshot
   */
  takeSnapshot(): MemorySnapshot {
    const memUsage = process.memoryUsage();

    return {
      timestamp: Date.now(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
      arrayBuffers: memUsage.arrayBuffers
    };
  }

  /**
   * Force garbage collection (if --expose-gc flag is used)
   */
  forceGC(): void {
    if (global.gc) {
      global.gc();
    } else {
      console.warn("GC not exposed. Run with --expose-gc flag for accurate memory measurements");
    }
  }

  /**
   * Get all stored profiles
   */
  getAllProfiles(): MemoryProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get a specific profile by name
   */
  getProfile(name: string): MemoryProfile | undefined {
    return this.profiles.get(name);
  }

  /**
   * Clear all stored profiles
   */
  clearProfiles(): void {
    this.profiles.clear();
  }

  /**
   * Format memory size for human reading
   */
  formatBytes(bytes: number): string {
    const sizes = ["B", "KB", "MB", "GB"];
    if (bytes === 0) return "0 B";

    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  /**
   * Generate a summary report for a profile
   */
  generateReport(profile: MemoryProfile): string {
    const duration = profile.endTime - profile.startTime;
    const startHeap = profile.snapshots[0]?.heapUsed ?? 0;
    const endHeap = profile.snapshots[profile.snapshots.length - 1]?.heapUsed ?? 0;

    return `
=== Memory Profile Report: ${profile.name} ===
Duration: ${duration}ms
Samples: ${profile.snapshots.length}

Memory Usage:
  Start Heap: ${this.formatBytes(startHeap)}
  End Heap: ${this.formatBytes(endHeap)}
  Peak Heap: ${this.formatBytes(profile.peakHeapUsed)}
  Average Heap: ${this.formatBytes(profile.averageHeapUsed)}
  Heap Growth: ${this.formatBytes(profile.heapGrowth)} (${profile.heapGrowth > 0 ? "+" : ""}${((profile.heapGrowth / startHeap) * 100).toFixed(2)}%)

Peak Memory:
  RSS: ${this.formatBytes(Math.max(...profile.snapshots.map((s) => s.rss)))}
  External: ${this.formatBytes(Math.max(...profile.snapshots.map((s) => s.external)))}
  Array Buffers: ${this.formatBytes(Math.max(...profile.snapshots.map((s) => s.arrayBuffers)))}
`.trim();
  }

  /**
   * Compare two memory profiles
   */
  compareProfiles(profile1: MemoryProfile, profile2: MemoryProfile): string {
    const p1Growth = profile1.heapGrowth;
    const p2Growth = profile2.heapGrowth;
    const growthDiff = p2Growth - p1Growth;
    const growthPercent = (growthDiff / Math.abs(p1Growth || 1)) * 100;

    const p1Peak = profile1.peakHeapUsed;
    const p2Peak = profile2.peakHeapUsed;
    const peakDiff = p2Peak - p1Peak;
    const peakPercent = (peakDiff / p1Peak) * 100;

    const p1Avg = profile1.averageHeapUsed;
    const p2Avg = profile2.averageHeapUsed;
    const avgDiff = p2Avg - p1Avg;
    const avgPercent = (avgDiff / p1Avg) * 100;

    return `
=== Memory Profile Comparison ===
${profile1.name} vs ${profile2.name}

Heap Growth:
  ${profile1.name}: ${this.formatBytes(p1Growth)}
  ${profile2.name}: ${this.formatBytes(p2Growth)}
  Difference: ${this.formatBytes(growthDiff)} (${growthPercent > 0 ? "+" : ""}${growthPercent.toFixed(2)}%)

Peak Heap Usage:
  ${profile1.name}: ${this.formatBytes(p1Peak)}
  ${profile2.name}: ${this.formatBytes(p2Peak)}
  Difference: ${this.formatBytes(peakDiff)} (${peakPercent > 0 ? "+" : ""}${peakPercent.toFixed(2)}%)

Average Heap Usage:
  ${profile1.name}: ${this.formatBytes(p1Avg)}
  ${profile2.name}: ${this.formatBytes(p2Avg)}
  Difference: ${this.formatBytes(avgDiff)} (${avgPercent > 0 ? "+" : ""}${avgPercent.toFixed(2)}%)

Winner: ${
      p2Growth < p1Growth && p2Peak < p1Peak && p2Avg < p1Avg
        ? profile2.name + " (better on all metrics)"
        : p1Growth < p2Growth && p1Peak < p2Peak && p1Avg < p2Avg
          ? profile1.name + " (better on all metrics)"
          : "Mixed results - check individual metrics"
    }
`.trim();
  }
}

/**
 * Higher-level memory testing utilities
 */
export class MemoryTester {
  private profiler = new MemoryProfiler();

  /**
   * Run a test function with memory profiling
   */
  async profileTest<T>(
    testName: string,
    testFn: () => T | Promise<T>,
    options: {
      warmupRuns?: number;
      samplingInterval?: number;
      forceGCBefore?: boolean;
      forceGCAfter?: boolean;
    } = {}
  ): Promise<{ result: T; profile: MemoryProfile }> {
    const { warmupRuns = 3, samplingInterval = 10, forceGCBefore = true, forceGCAfter = true } = options;

    // Warmup runs to eliminate JIT compilation effects
    for (let i = 0; i < warmupRuns; i++) {
      await testFn();
    }

    if (forceGCBefore) {
      this.profiler.forceGC();
      // Wait a bit for GC to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.profiler.start(testName, samplingInterval);
    const result = await testFn();
    const profile = this.profiler.stop()!;

    if (forceGCAfter) {
      this.profiler.forceGC();
    }

    return { result, profile };
  }

  /**
   * Compare two test functions with memory profiling
   */
  async compareTests<T1, T2>(
    test1Name: string,
    test1Fn: () => T1 | Promise<T1>,
    test2Name: string,
    test2Fn: () => T2 | Promise<T2>,
    options: {
      runs?: number;
      samplingInterval?: number;
    } = {}
  ): Promise<{
    test1Results: Array<{ result: T1; profile: MemoryProfile }>;
    test2Results: Array<{ result: T2; profile: MemoryProfile }>;
    comparison: string;
  }> {
    const { runs = 5, samplingInterval = 10 } = options;

    const test1Results: Array<{ result: T1; profile: MemoryProfile }> = [];
    const test2Results: Array<{ result: T2; profile: MemoryProfile }> = [];

    // Run tests alternately to reduce systemic bias
    for (let i = 0; i < runs; i++) {
      // Test 1
      const result1 = await this.profileTest(`${test1Name}-run-${i}`, test1Fn, { samplingInterval });
      test1Results.push(result1);

      // Small pause between tests
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Test 2
      const result2 = await this.profileTest(`${test2Name}-run-${i}`, test2Fn, { samplingInterval });
      test2Results.push(result2);

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Calculate average profiles
    const avgProfile1 = this.calculateAverageProfile(
      test1Name,
      test1Results.map((r) => r.profile)
    );
    const avgProfile2 = this.calculateAverageProfile(
      test2Name,
      test2Results.map((r) => r.profile)
    );

    const comparison = this.profiler.compareProfiles(avgProfile1, avgProfile2);

    return {
      test1Results,
      test2Results,
      comparison
    };
  }

  private calculateAverageProfile(name: string, profiles: MemoryProfile[]): MemoryProfile {
    const avgHeapGrowth = profiles.reduce((sum, p) => sum + p.heapGrowth, 0) / profiles.length;
    const avgPeakHeap = profiles.reduce((sum, p) => sum + p.peakHeapUsed, 0) / profiles.length;
    const avgAverageHeap = profiles.reduce((sum, p) => sum + p.averageHeapUsed, 0) / profiles.length;

    return {
      name: `${name}-average`,
      snapshots: [], // Not meaningful for average
      startTime: 0,
      endTime: 0,
      peakHeapUsed: avgPeakHeap,
      heapGrowth: avgHeapGrowth,
      averageHeapUsed: avgAverageHeap
    };
  }
}

// Global memory profiler instance
export const memoryProfiler = new MemoryProfiler();
export const memoryTester = new MemoryTester();
