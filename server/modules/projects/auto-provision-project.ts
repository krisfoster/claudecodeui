import { AppError } from '@/shared/utils.js';

import { createProject } from './services/project-management.service.js';

export type AutoProvisionProjectDependencies = {
  createProject(projectPath: string): Promise<unknown>;
};

export type AutoProvisionProjectOptions = {
  projectPath?: string;
};

/**
 * Registers a project for a path handed in from outside (e.g. an extra
 * workspace mounted into a sandbox), so it shows up ready to open instead
 * of requiring a human to type/browse to it through the folder picker.
 * `createProject` throws PROJECT_ALREADY_EXISTS on a path that's already
 * registered — treated as a no-op here rather than an error, since this
 * runs on every boot and the path won't change between restarts.
 */
export async function autoProvisionDefaultProject(
  dependencies: AutoProvisionProjectDependencies,
  options: AutoProvisionProjectOptions,
): Promise<{ projectPath: string } | null> {
  if (!options.projectPath) {
    return null;
  }

  try {
    await dependencies.createProject(options.projectPath);
    return { projectPath: options.projectPath };
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROJECT_ALREADY_EXISTS') {
      return null;
    }
    throw error;
  }
}

/**
 * Called once at server boot. Only acts when CLOUDCLI_DEFAULT_PROJECT_PATH
 * is set — the sbx kit's `ccui-sbx` launcher sets it when an extra
 * workspace path is passed alongside the primary checkout.
 */
export async function autoProvisionDefaultProjectIfConfigured() {
  return autoProvisionDefaultProject(
    { createProject: (projectPath) => createProject({ projectPath }) },
    { projectPath: process.env.CLOUDCLI_DEFAULT_PROJECT_PATH || undefined },
  );
}
