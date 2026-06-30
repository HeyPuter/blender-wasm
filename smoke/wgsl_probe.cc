#include <cstdio>
#include <vector>
#include <shaderc/shaderc.hpp>
#include "src/tint/lang/spirv/reader/reader.h"
#include "src/tint/lang/wgsl/writer/writer.h"
#include "src/tint/lang/core/ir/module.h"

int main() {
  const char *glsl =
    "#version 450\n"
    "layout(location=0) out vec4 c;\n"
    "void main(){ c = vec4(1.0,0.5,0.2,1.0); }\n";
  shaderc::Compiler compiler;
  shaderc::CompileOptions opt;
  opt.SetTargetEnvironment(shaderc_target_env_vulkan, shaderc_env_version_vulkan_1_0);
  auto res = compiler.CompileGlslToSpv(glsl, shaderc_fragment_shader, "p.frag", opt);
  if (res.GetCompilationStatus() != shaderc_compilation_status_success) {
    printf("SHADERC FAIL: %s\n", res.GetErrorMessage().c_str()); return 1;
  }
  std::vector<uint32_t> spirv(res.cbegin(), res.cend());
  printf("SPIRV: %zu words\n", spirv.size());

  auto ir = tint::spirv::reader::ReadIR(spirv, {});
  if (ir != tint::Success) {
    printf("TINT READ FAIL: [%s]\n", ir.Failure().reason.c_str()); return 2;
  }
  auto out = tint::wgsl::writer::WgslFromIR(ir.Get(), {});
  if (out != tint::Success) {
    printf("TINT WRITE FAIL: %s\n", out.Failure().reason.c_str()); return 3;
  }
  printf("WGSL OK (%zu chars):\n%s\n", out.Get().wgsl.size(), out.Get().wgsl.c_str());
  return 0;
}
