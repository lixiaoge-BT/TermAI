import ctypes, os
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
kernel32.SetFileAttributesW.restype = wintypes.BOOL
kernel32.DeleteFileW.argtypes = [wintypes.LPCWSTR]
kernel32.DeleteFileW.restype = wintypes.BOOL
kernel32.RemoveDirectoryW.argtypes = [wintypes.LPCWSTR]
kernel32.RemoveDirectoryW.restype = wintypes.BOOL
kernel32.FindFirstFileW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p]
kernel32.FindFirstFileW.restype = wintypes.HANDLE
kernel32.FindNextFileW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.FindNextFileW.restype = wintypes.BOOL
kernel32.FindClose.argtypes = [wintypes.HANDLE]
kernel32.FindClose.restype = wintypes.BOOL
INVALID_HANDLE = wintypes.HANDLE(-1).value
FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_NORMAL = 0x80

class WIN32_FIND_DATAW(ctypes.Structure):
    _fields_ = [
        ("dwFileAttributes", wintypes.DWORD),
        ("ftCreationTime", wintypes.FILETIME),
        ("ftLastAccessTime", wintypes.FILETIME),
        ("ftLastWriteTime", wintypes.FILETIME),
        ("nFileSizeHigh", wintypes.DWORD),
        ("nFileSizeLow", wintypes.DWORD),
        ("dwReserved0", wintypes.DWORD),
        ("dwReserved1", wintypes.DWORD),
        ("cFileName", wintypes.WCHAR * 260),
        ("cAlternateFileName", wintypes.WCHAR * 14),
    ]

def del_tree(root):
    kernel32.SetFileAttributesW(root, FILE_ATTRIBUTE_NORMAL)
    data = WIN32_FIND_DATAW()
    handle = kernel32.FindFirstFileW(os.path.join(root, "*"), ctypes.byref(data))
    if handle == INVALID_HANDLE:
        if not kernel32.RemoveDirectoryW(root):
            print("rmdir(empty) fail", root, ctypes.get_last_error())
        return
    try:
        while True:
            name = data.cFileName
            if name not in (".", ".."):
                child = os.path.join(root, name)
                kernel32.SetFileAttributesW(child, FILE_ATTRIBUTE_NORMAL)
                if data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY:
                    del_tree(child)
                else:
                    if not kernel32.DeleteFileW(child):
                        print("del fail", child, ctypes.get_last_error())
            if not kernel32.FindNextFileW(handle, ctypes.byref(data)):
                break
    finally:
        kernel32.FindClose(handle)
    if not kernel32.RemoveDirectoryW(root):
        print("rmdir fail", root, ctypes.get_last_error())

root = "\\\\?\\D:\\Trae\\release\\0.1.0"
if os.path.exists(root):
    del_tree(root)
    print("after exists =", os.path.exists(root))
else:
    print("already gone")
