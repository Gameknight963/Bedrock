#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <stdlib.h>
#include <stdio.h>
static napi_status (*make_int)(napi_env,int32_t,napi_value*);
static napi_status (*make_object)(napi_env,napi_value*);
static napi_status (*define)(napi_env,napi_value,size_t,const napi_property_descriptor*);
static napi_status (*set_property)(napi_env,napi_value,const char*,napi_value);
static napi_status (*wrap_object)(napi_env,napi_value,void*,napi_finalize,void*,napi_ref*);
static napi_status (*remove_wrap)(napi_env,napi_value,void**);
static napi_status (*make_reference)(napi_env,napi_value,uint32_t,napi_ref*);
static napi_status (*get_reference)(napi_env,napi_ref,napi_value*);
static napi_status (*delete_reference)(napi_env,napi_ref);
static napi_status (*add_cleanup)(napi_env,void (*)(void*),void*);
static napi_status (*remove_cleanup)(napi_env,void (*)(void*),void*);
static napi_status (*throw_error)(napi_env,const char*,const char*);
static napi_ref resource_ref;
static int resource_data, disposed, fail_next;
static void increment(const char *name) {
    char value[32]; DWORD length=GetEnvironmentVariableA(name,value,sizeof(value));
    int number=length?atoi(value):0;
    snprintf(value,sizeof(value),"%d",number+1); SetEnvironmentVariableA(name,value);
}
static void cleanup(void *data) { (void)data; increment("BEDROCK_TEST_CLEANUP"); }
static void finalizer(napi_env env,void *data,void *hint) { (void)env;(void)data;(void)hint;increment("BEDROCK_TEST_FINALIZER"); }
static napi_value invoke(napi_env env,napi_callback_info info) {
    (void)info;napi_value value;make_int(env,FIXTURE_VERSION,&value);return value;
}
static napi_value fail(napi_env env,napi_callback_info info) {
    (void)info;fail_next=1;return invoke(env,info);
}
static napi_value dispose(napi_env env,napi_callback_info info) {
    (void)info;
    if(fail_next) {fail_next=0;throw_error(env,NULL,"Fixture disposal failed");return NULL;}
    if(!disposed) {
        increment("BEDROCK_TEST_DISPOSE");
#ifndef UNSAFE_CLEANUP
        remove_cleanup(env,cleanup,&resource_data);
#endif
        if(resource_ref) {
#ifndef UNSAFE_FINALIZER
            napi_value object;void *data;
            get_reference(env,resource_ref,&object);remove_wrap(env,object,&data);
#endif
            delete_reference(env,resource_ref);resource_ref=NULL;
        }
        disposed=1;
    }
    return invoke(env,info);
}
NAPI_MODULE_INIT() {
    HMODULE host=GetModuleHandleW(NULL);
#define RESOLVE(pointer,name) pointer=(void*)GetProcAddress(host,name)
    RESOLVE(make_int,"napi_create_int32"); RESOLVE(make_object,"napi_create_object");
    RESOLVE(define,"napi_define_properties"); RESOLVE(set_property,"napi_set_named_property");
    RESOLVE(wrap_object,"napi_wrap");RESOLVE(remove_wrap,"napi_remove_wrap");
    RESOLVE(make_reference,"napi_create_reference");RESOLVE(get_reference,"napi_get_reference_value");
    RESOLVE(delete_reference,"napi_delete_reference");RESOLVE(add_cleanup,"napi_add_env_cleanup_hook");
    RESOLVE(remove_cleanup,"napi_remove_env_cleanup_hook");RESOLVE(throw_error,"napi_throw_error");
    napi_property_descriptor methods[]={
        {"invoke",NULL,invoke,NULL,NULL,NULL,napi_default,NULL},
        {"dispose",NULL,dispose,NULL,NULL,NULL,napi_default,NULL},
        {"failNextDispose",NULL,fail,NULL,NULL,NULL,napi_default,NULL}
    };
    define(env,exports,3,methods);
    napi_value resource;make_object(env,&resource);
    wrap_object(env,resource,&resource_data,finalizer,NULL,NULL);
    make_reference(env,resource,1,&resource_ref);
    set_property(env,exports,"resource",resource);
    add_cleanup(env,cleanup,&resource_data);
    return exports;
}

