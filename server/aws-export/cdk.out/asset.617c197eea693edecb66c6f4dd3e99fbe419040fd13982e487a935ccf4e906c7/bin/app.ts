#!/usr/bin/env node

import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { ExportStack } from '../lib/export-stack';

const app = new App();

new ExportStack(app, 'MeliesExportStack', {
  // Account/region are picked up from the default CDK environment.
});
