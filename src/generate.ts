import { confirm, select } from '@clack/prompts';
import assert from 'assert';
import fs from 'fs-extra';
import path from 'path';
// @ts-ignore
import randomColor from 'random-color';
import { type Config, loadConfig } from './config';
import { CONFIG_FILE, FRAMEWORK_NAME } from './constants';
import { sync } from './sync';

interface GenerateOptions {
  cwd: string;
  type: string;
  name: string;
  config: Config;
}

const generateCommands = ['entry', 'tailwindcss'];

type CommandType = 'page' | 'tailwindcss' | 'entry';

type CommandHandlerType = {
  [K in CommandType]: (opts: GenerateOptions) => void;
};

export async function generate(opts: GenerateOptions) {
  const { type, name, cwd } = opts;
  let selectedType = type;

  if (!opts.type) {
    selectedType = (await select({
      message: 'Select the command to initialize:',
      options: generateCommands.map((command) => ({
        label: command,
        value: command,
      })),
    })) as string;
  }

  const commandHandler: CommandHandlerType = {
    page: generatePage,
    tailwindcss: generateTailwindcss,
    entry: generateEntry,
  };

  if (!(selectedType in commandHandler)) {
    throw new Error(`Unknown command: ${selectedType}`);
  }

  const rawConfig = await loadConfig({ cwd });
  if (rawConfig.entry) {
    rawConfig.entry.client = 'src/client.tsx';
  } else {
    rawConfig.entry = {
      client: 'src/client.tsx',
    };
  }

  commandHandler[selectedType as CommandType]({ ...opts, config: rawConfig });
}

function generatePage(opts: GenerateOptions) {
  assert(opts.name, 'Name is required');
  const pagesDir = path.join(opts.cwd, 'src/pages');
  const pageName = opts.name;
  const pagePath = path.join(pagesDir, `${pageName}.tsx`);
  const styleModulePath = path.join(pagesDir, `${pageName}.module.less`);

  assert(
    !fs.existsSync(pagePath) && !fs.existsSync(styleModulePath),
    `Page ${pageName} already exists.`,
  );

  fs.ensureDirSync(pagesDir);

  const componentName = pageName.charAt(0).toUpperCase() + pageName.slice(1);
  const pageContent = `import React from 'react';
import { createFileRoute } from '@umijs/tnf/router';
import styles from './${pageName}.module.less';

export const Route = createFileRoute('/${pageName}')({
  component: ${componentName},
});

function ${componentName}() {
  return (
    <div className={styles.container}>
      <h3>Welcome to ${componentName} Page!</h3>
    </div>
  );
}
`;

  const styleContent = `.container {
  color: ${randomColor().hexString()};
}
`;

  fs.writeFileSync(pagePath, pageContent);
  fs.writeFileSync(styleModulePath, styleContent);

  console.log(`Generated page at: ${pagePath}`);
  console.log(`Generated styles at: ${styleModulePath}`);
}

type FileOperationResult = {
  path: string;
  success: boolean;
  message?: string;
};

async function updateConfigFile(
  cwd: string,
  config: Config,
): Promise<FileOperationResult> {
  const configPath = path.join(cwd, `${CONFIG_FILE}.ts`);
  const configContent = `export default ${JSON.stringify(
    config,
    null,
    2,
  ).replace(/"([^"]+)":/g, '$1:')}`;

  try {
    await fs.writeFile(configPath, configContent);
    return {
      path: configPath,
      success: true,
      message: `Updated config file at: ${CONFIG_FILE}.ts`,
    };
  } catch (error) {
    return {
      path: configPath,
      success: false,
      message: `Failed to update config file: ${error}`,
    };
  }
}

async function writeFileWithConfirmation(
  filePath: string,
  content: string,
  confirmMessage: string,
): Promise<FileOperationResult> {
  if (fs.existsSync(filePath)) {
    const shouldOverwrite = await confirm({
      message: confirmMessage,
    });

    if (!shouldOverwrite) {
      return {
        path: filePath,
        success: false,
        message: `Skipped writing to ${filePath}`,
      };
    }
  }

  try {
    await fs.writeFile(filePath, content);
    return {
      path: filePath,
      success: true,
      message: `Generated file at: ${filePath}`,
    };
  } catch (error) {
    return {
      path: filePath,
      success: false,
      message: `Failed to write file: ${error}`,
    };
  }
}

async function generateTailwindcss({ cwd, config }: GenerateOptions) {
  const tailwindConfig = `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx}",
    "./src/components/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}`;

  const tailwindCSS = `@tailwind base;
@tailwind components;
@tailwind utilities;`;

  fs.ensureDirSync(path.join(cwd, 'src'));

  const tailwindConfigPath = path.join(cwd, 'tailwind.config.js');
  const tailwindCSSPath = path.join(cwd, 'src/tailwind.css');

  const results = await Promise.all([
    writeFileWithConfirmation(
      tailwindConfigPath,
      tailwindConfig,
      'Tailwind config file already exists, do you want to overwrite?',
    ),
    writeFileWithConfirmation(
      tailwindCSSPath,
      tailwindCSS,
      'Tailwind CSS file already exists, do you want to overwrite?',
    ),
  ]);

  // 更新配置
  config.tailwindcss = true;
  const configResult = await updateConfigFile(cwd, config);

  // 输出结果
  results
    .concat(configResult)
    .filter((result) => result.success)
    .forEach((result) => console.log(result.message));
}

async function generateEntry({ cwd, config }: GenerateOptions) {
  const tnfPath = path.join(cwd, `src/.${FRAMEWORK_NAME}`);
  const clientSrcPath = path.join(tnfPath, 'client.tsx');
  const clientDestPath = path.join(cwd, 'src/client.tsx');

  if (!fs.existsSync(tnfPath)) {
    await sync({
      config: await loadConfig({ cwd }),
      cwd,
      tmpPath: tnfPath,
      mode: 'development',
    });
  }

  if (!fs.existsSync(clientSrcPath)) {
    throw new Error('client.tsx template not found in .tnf directory');
  }

  const content = await fs.readFile(clientSrcPath, 'utf-8');
  const processedContent = processImportPaths(
    content,
    clientSrcPath,
    clientDestPath,
  );

  const writeResult = await writeFileWithConfirmation(
    clientDestPath,
    processedContent,
    'client.tsx already exists. Do you want to overwrite it?',
  );

  if (writeResult.success) {
    config.entry = {
      ...config.entry,
      client: 'src/client.tsx',
    };

    const configResult = await updateConfigFile(cwd, config);
    console.log(writeResult.message);
    if (configResult.success) {
      console.log(configResult.message);
    }
  }
}

function processImportPaths(
  content: string,
  sourcePath: string,
  destPath: string,
): string {
  return content.replace(/from ['"]([^'"]+)['"]/g, (match, importPath) => {
    if (importPath.startsWith('.')) {
      const relativePath = path.relative(
        path.dirname(destPath),
        path.resolve(path.dirname(sourcePath), importPath),
      );
      const normalizedPath = relativePath.startsWith('.')
        ? relativePath
        : `./${relativePath}`;
      return `from '${normalizedPath}'`;
    }
    return match;
  });
}
