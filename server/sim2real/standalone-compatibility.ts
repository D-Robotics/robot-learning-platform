import path from 'node:path';
import type { RdkPlatform } from '../../shared/board-types.js';
import type {
  ModelArtifactDescriptor,
  ModelArtifactFormat,
  ModelCompatibilityResult,
  ModelPlatformTarget,
} from '../../shared/model-artifacts.js';

const TARGETS: Record<RdkPlatform, ModelPlatformTarget> = {
  'rdk-x3': { family: 'rdk', platformId: 'rdk-x3', acceleratorArchitecture: 'bernoulli2', toolchainTarget: 'rdk-x3', compiledFormats: ['bin'], runtimePackages: ['bpu_infer_lib_x3'] },
  'rdk-x5': { family: 'rdk', platformId: 'rdk-x5', acceleratorArchitecture: 'bayes-e', toolchainTarget: 'rdk-x5', compiledFormats: ['bin'], runtimePackages: ['bpu_infer_lib_x5'] },
  'rdk-ultra': { family: 'rdk', platformId: 'rdk-ultra', acceleratorArchitecture: 'bayes-e', toolchainTarget: 'rdk-ultra', compiledFormats: ['bin'], runtimePackages: ['bpu_infer_lib_x5'] },
  'rdk-s100': { family: 'rdk', platformId: 'rdk-s100', acceleratorArchitecture: 'nash', toolchainTarget: 'rdk-s100', compiledFormats: ['bin'], runtimePackages: ['bpu_infer_lib_s100'] },
  'rdk-s100p': { family: 'rdk', platformId: 'rdk-s100p', acceleratorArchitecture: 'nash', toolchainTarget: 'rdk-s100p', compiledFormats: ['bin'], runtimePackages: ['bpu_infer_lib_s100'] },
  'rdk-s600': { family: 'rdk', platformId: 'rdk-s600', acceleratorArchitecture: 'nash', toolchainTarget: 'rdk-s600', compiledFormats: ['hbm'], runtimePackages: ['hbm_runtime'] },
};

export const RDK_MODEL_COMPATIBILITY_MATRIX = TARGETS;

export function inferModelArtifactFormat(name: string): ModelArtifactFormat {
  const ext = path.extname(String(name || '')).toLowerCase();
  return ({ '.pt': 'pytorch', '.pth': 'pytorch', '.onnx': 'onnx', '.bin': 'bin', '.hbm': 'hbm', '.gguf': 'gguf' } as Record<string, ModelArtifactFormat>)[ext] || 'unknown';
}

export function evaluateModelCompatibility(platformId: string, artifact: ModelArtifactDescriptor): ModelCompatibilityResult {
  const platform = TARGETS[platformId as RdkPlatform] ?? null;
  if (!platform) return { status: 'unknown-platform', platform: null, reasons: [`No model compatibility target is registered for ${platformId || 'unknown'}.`] };
  if (artifact.kind === 'source' || artifact.format === 'onnx' || artifact.format === 'pytorch') {
    return { status: 'requires-conversion', platform, reasons: [`${artifact.format} is a source artifact and must be compiled for ${platform.toolchainTarget}.`] };
  }
  if (!platform.compiledFormats.includes(artifact.format)) {
    return { status: 'incompatible', platform, reasons: [`${artifact.format} is not accepted by ${platform.platformId}; expected ${platform.compiledFormats.join(' or ')}.`] };
  }
  const targets = (artifact.targetPlatforms || []).map((item) => item.trim()).filter(Boolean);
  if (targets.length && !targets.includes(platform.platformId)) return { status: 'incompatible', platform, reasons: [`Artifact targets ${targets.join(', ')}, not ${platform.platformId}.`] };
  if (artifact.toolchainTarget && artifact.toolchainTarget.trim() !== platform.toolchainTarget) return { status: 'incompatible', platform, reasons: [`Artifact toolchain target ${artifact.toolchainTarget} does not match ${platform.toolchainTarget}.`] };
  if (artifact.acceleratorArchitecture && artifact.acceleratorArchitecture.trim().toLowerCase() !== platform.acceleratorArchitecture) return { status: 'incompatible', platform, reasons: [`Artifact architecture ${artifact.acceleratorArchitecture} does not match ${platform.acceleratorArchitecture}.`] };
  if (targets.length || artifact.toolchainTarget) return { status: 'compatible', platform, reasons: [`Artifact declares target ${platform.platformId}.`] };
  return { status: 'needs-validation', platform, reasons: ['Compiled artifact is missing exact board/toolchain target metadata.'] };
}
