/* Android file publication must preserve the session.lock inode and never
 * replace an existing log. Linux renameat2 provides atomic no-replace moves
 * without hard links, which Android app SELinux policies prohibit. */
#include <fcntl.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static char *publish_path(napi_env env, napi_value value) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > 4096) return NULL;
  char *path = malloc(length + 1);
  if (path == NULL) return NULL;
  size_t copied;
  if (napi_get_value_string_utf8(env, value, path, length + 1, &copied) != napi_ok ||
      copied != length || strlen(path) != length || path[0] != '/') {
    free(path);
    return NULL;
  }
  return path;
}

static napi_value publish_new_file(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    (void)napi_throw_type_error(env, NULL, "publishNewFile requires two absolute paths");
    return NULL;
  }
  char *source = publish_path(env, argv[0]);
  char *target = publish_path(env, argv[1]);
  if (source == NULL || target == NULL) {
    free(source); free(target);
    (void)napi_throw_type_error(env, NULL, "publishNewFile requires two absolute paths");
    return NULL;
  }
  int error = syscall(__NR_renameat2, AT_FDCWD, source, AT_FDCWD, target, 1 /* RENAME_NOREPLACE */) == 0 ? 0 : errno;
  free(source); free(target);
  napi_value result;
  if (napi_create_int32(env, error, &result) != napi_ok) return NULL;
  return result;
}

static napi_status define_android_publish(napi_env env, napi_value exports) {
  napi_value function;
  napi_status status = napi_create_function(env, "publishNewFile", NAPI_AUTO_LENGTH,
                                            publish_new_file, NULL, &function);
  return status == napi_ok ? napi_set_named_property(env, exports, "publishNewFile", function) : status;
}
