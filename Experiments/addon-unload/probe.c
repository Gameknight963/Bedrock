#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <node_api.h>
static napi_status (*get_args)(napi_env,napi_callback_info,size_t*,napi_value*,napi_value*,void**);
static napi_status (*get_text)(napi_env,napi_value,char*,size_t,size_t*);
static napi_status (*make_int)(napi_env,int32_t,napi_value*);
static napi_status (*define)(napi_env,napi_value,size_t,const napi_property_descriptor*);
static napi_value operation(napi_env env,napi_callback_info info) {
    napi_value args[2], result; size_t count=2, length; char action[32], path[32768]; wchar_t wide[32768];
    get_args(env,info,&count,args,NULL,NULL);
    get_text(env,args[0],action,sizeof(action),&length);
    get_text(env,args[1],path,sizeof(path),&length);
    MultiByteToWideChar(CP_UTF8,0,path,-1,wide,32768);
    DWORD error=0;
    if (!lstrcmpA(action,"free")) {
        HMODULE module=GetModuleHandleW(wide);
        if (!module) error=GetLastError();
        else if (!FreeLibrary(module)) error=GetLastError();
    } else if (!lstrcmpA(action,"mapped")) {
        error=GetModuleHandleW(wide)?1:0;
    } else if (!lstrcmpA(action,"posix")) {
        HANDLE file=CreateFileW(wide,DELETE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,0,NULL);
        if(file==INVALID_HANDLE_VALUE) error=GetLastError();
        else {
            FILE_DISPOSITION_INFO_EX disposition={FILE_DISPOSITION_FLAG_DELETE|FILE_DISPOSITION_FLAG_POSIX_SEMANTICS};
            if(!SetFileInformationByHandle(file,FileDispositionInfoEx,&disposition,sizeof(disposition))) error=GetLastError();
            CloseHandle(file);
        }
    }
    make_int(env,(int32_t)error,&result); return result;
}
NAPI_MODULE_INIT() {
    HMODULE host=GetModuleHandleW(NULL);
    get_args=(void*)GetProcAddress(host,"napi_get_cb_info");
    get_text=(void*)GetProcAddress(host,"napi_get_value_string_utf8");
    make_int=(void*)GetProcAddress(host,"napi_create_int32");
    define=(void*)GetProcAddress(host,"napi_define_properties");
    napi_property_descriptor method={"operation",NULL,operation,NULL,NULL,NULL,napi_default,NULL};
    define(env,exports,1,&method); return exports;
}
