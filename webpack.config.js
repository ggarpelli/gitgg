//@ts-check

'use strict';

const path = require('path');
// Import the copy plugin.
const CopyPlugin = require('copy-webpack-plugin');

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node', // VS Code extensions run in a Node.js-context
  entry: './src/extension.ts', // The entry point of your extension
  output: {
    // The bundle is stored in the 'dist' folder (check package.json)
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode', // The vscode-module is created on-the-fly and must be excluded.
  },
  resolve: {
    // Support reading TypeScript and JavaScript files
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  // Configure the plugin to copy the 'webview' folder.
  plugins: [
    new CopyPlugin({
        patterns: [
            { from: 'src/webview', to: 'webview' } // Copies from 'src/webview' to 'dist/webview'
        ]
    })
  ],
  devtool: 'source-map',
};
module.exports = config;