Update: the plugin is now published to npm as **dsh-storage-insight@0.1.0** — https://www.npmjs.com/package/dsh-storage-insight

The catalog entry fields have been updated in the repository:

```json
{
  "npm": "dsh-storage-insight",
  "version": "0.1.0",
  "install": "dsh plugin --profile web add dsh-storage-insight"
}
```

GitHub-source install also works and was verified end to end:
`dsh plugin --profile desktop add github:superchen061220/dsh-storage-insight`

One note for the catalog maintainers: on an **existing** profile, `dsh plugin add` installs the dependency but does not register it in `dsh.profile.bundles`, so the plugin stays inactive until it is enabled from the Plugins page. Fresh profiles register it automatically. That is dsh's own behaviour, not plugin-specific.
