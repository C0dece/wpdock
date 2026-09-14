/**
 * Build script: packs the WPDock agent PHP plugin into a ZIP file
 * that the extension will upload to remote WordPress sites.
 * Run: node scripts/pack-agent.js
 */
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const agentDir = path.join(__dirname, "..", "resources", "agent-plugin");
const outputZip = path.join(__dirname, "..", "resources", "wpdock-agent.zip");

const zip = new AdmZip();
zip.addLocalFolder(agentDir, "wpdock-agent");
zip.writeZip(outputZip);

console.log(`Agent ZIP created: ${outputZip}`);
