cmake_minimum_required(VERSION 3.22)
# cmake_policy(SET CPM0091 NEW)
# cmake_policy(SET CPM0042 NEW)

project(alembic-js VERSION 1.0 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
message(STATUS "cmake prefix path: ${CMAKE_PREFIX_PATH}")
find_package(Alembic REQUIRED)

add_definitions(-DNAPI_VERSION=10)
include_directories(${CMAKE_JS_INC} "addons")
file(GLOB SOURCE_FILES "addons/*")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB} Alembic::Alembic)

if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET})
endif()

add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy
    $<TARGET_FILE:${PROJECT_NAME}>
    ${CMAKE_SOURCE_DIR}/build/${PROJECT_NAME}.node
)