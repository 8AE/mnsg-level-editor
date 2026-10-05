# Goemon 64: Recompiled Symbols

This repo contains the symbol files used by the [recompiler](https://github.com/N64Recomp/N64Recomp) to generate the code for the [Goemon 64: Recompiled project](https://github.com/klorfmorf/Goemon64Recomp).
These files were generated from the [Mystical Ninja Starring Goemon decompilation project](https://github.com/klorfmorf/mnsg), which allows the recompilation project to use function and variable names from the decompilation to help with writing patches.

This is a separate repo from the main one so that mods can reference just this repo instead of the recompilation's entire repo. It also helps avoid bloating the main repo's size and history, as the symbol files are very large.

The syms.toml file contains function definitions that the recompiler uses to find code in the ROM during the initial recompilation. The syms.toml, datasyms.toml, and datasyms_static.toml files are all used during patch recompilation to allow the recompiler to resolve references to functions and variables in patch code. This allows patches to be written by copying in matched functions from the decompilation and tweaking them.

## Modding

> [!NOTE]
> This section refers to functionality that's still a work in progress. The tooling mentioned here is not available yet.

Mods can submodule/subrepo this repo (or just copy the files from it) to provide to the mod builder (TODO link the mod builder when it's available). Commits of this repo are tied to commits of the decompilation project, so mods should use the correspoding decompilation commit in order to guarantee consistency between headers and symbol names.

The commit of the decompilation that these symbols were generated from can be found [here](https://github.com/klorfmorf/mnsg/tree/46fd804bd4ce15e4f36d46163ffec6957e1e157b).

Mods do not have to update these files to support newer versions of the recompilation project, as symbol names are discarded in the process of building a mod.
