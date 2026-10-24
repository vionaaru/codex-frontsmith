"""Frontsmith Privacy Service."""

import os
import sys

# Windows: DLL MSVC runtime (пакет msvc-runtime) лежат в корне venv. Каталог
# добавляется в поиск DLL до импорта torch, иначе c10.dll не загружается.
if sys.platform == "win32" and os.path.exists(os.path.join(sys.prefix, "msvcp140.dll")):
    os.add_dll_directory(sys.prefix)
