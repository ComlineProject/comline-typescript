// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The measured region for callgrind: `region(fn)` calls `fn` from inside
// `comline_bench_region`, so `valgrind --tool=callgrind --collect-atstart=no
// --toggle-collect=comline_bench_region` counts only what `fn` runs (and
// the constant cost of one N-API call). No valgrind header needed.
//
//     cc -O2 -shared -fPIC -I"$(dirname "$(dirname "$(which node)")")/include/node" \
//        -o ../.core/region.node region.c

#include <node_api.h>

__attribute__((noinline, visibility("default")))
napi_value comline_bench_region(napi_env env, napi_value fn) {
  napi_value global, result;
  if (napi_get_global(env, &global) != napi_ok) return NULL;
  if (napi_call_function(env, global, fn, 0, NULL, &result) != napi_ok) return NULL;
  return result;
}

static napi_value region(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value fn;
  if (napi_get_cb_info(env, info, &argc, &fn, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "region(fn)");
    return NULL;
  }
  return comline_bench_region(env, fn);
}

NAPI_MODULE_INIT() {
  napi_value f;
  if (napi_create_function(env, "region", NAPI_AUTO_LENGTH, region, NULL, &f) != napi_ok) return NULL;
  if (napi_set_named_property(env, exports, "region", f) != napi_ok) return NULL;
  return exports;
}
