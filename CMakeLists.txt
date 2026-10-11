cmake_minimum_required(VERSION 3.22)

project(alembic-js VERSION 1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(ALEMBIC_JS_BUILD_TOOLS "Build the test fixture generator (tools/)" OFF)

message(STATUS "cmake prefix path: ${CMAKE_PREFIX_PATH}")
find_package(Alembic REQUIRED)

add_definitions(-DNAPI_VERSION=10 -DNAPI_CPP_EXCEPTIONS)
include_directories(${CMAKE_JS_INC} "addons")
file(GLOB SOURCE_FILES "addons/*.cpp" "addons/*.h")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB} Alembic::Alembic)

# On MSVC, every object linked together must use the same CRT and iterator debug
# level. If the installed Alembic SDK only ships a Debug build, compile against the
# debug CRT so the Release addon still links (LNK2038 otherwise).
function(alembic_js_match_sdk_runtime target)
    if(NOT MSVC)
        return()
    endif()
    get_target_property(_abc_configs Alembic::Alembic IMPORTED_CONFIGURATIONS)
    if(_abc_configs STREQUAL "DEBUG")
        message(STATUS "Alembic SDK provides only a DEBUG build; ${target} will use the debug CRT")
        set_property(TARGET ${target} PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreadedDebugDLL")
        target_compile_definitions(${target} PRIVATE _DEBUG _ITERATOR_DEBUG_LEVEL=2)
    endif()
endfunction()
alembic_js_match_sdk_runtime(${PROJECT_NAME})

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET})
endif()

# Copy the addon (and, on Windows, its runtime DLL dependencies such as Imath)
# to build/ where the TypeScript layer loads it from. Windows resolves the DLLs
# of a .node module from the module's own directory.
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
    $<TARGET_FILE:${PROJECT_NAME}>
    ${CMAKE_SOURCE_DIR}/build/${PROJECT_NAME}.node
)
if(WIN32)
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_RUNTIME_DLLS:${PROJECT_NAME}> $<TARGET_FILE:${PROJECT_NAME}>
        ${CMAKE_SOURCE_DIR}/build/
        COMMAND_EXPAND_LISTS
    )
endif()

if(ALEMBIC_JS_BUILD_TOOLS)
    add_executable(generate_fixtures tools/generate_fixtures.cpp)
    target_link_libraries(generate_fixtures Alembic::Alembic)
    alembic_js_match_sdk_runtime(generate_fixtures)
    if(WIN32)
        add_custom_command(TARGET generate_fixtures POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
            $<TARGET_RUNTIME_DLLS:generate_fixtures>
            $<TARGET_FILE_DIR:generate_fixtures>
            COMMAND_EXPAND_LISTS
        )
    endif()
endif()
