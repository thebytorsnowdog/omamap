cmake_minimum_required(VERSION 3.21)
project(omamap VERSION 0.3.2 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
include(GNUInstallDirs)

find_package(Qt6 6.6 REQUIRED COMPONENTS Core Gui Widgets Network WebEngineCore WebEngineWidgets)

add_executable(omamap
  main.cpp
  recent.cpp recent.h
  scheme.cpp scheme.h
  theme.cpp theme.h
  window.cpp window.h
)

target_compile_definitions(omamap PRIVATE
  OMAMAP_VERSION="${PROJECT_VERSION}"
  OMAMAP_INSTALLED_CORE="${CMAKE_INSTALL_FULL_DATADIR}/omamap/core"
  OMAMAP_SOURCE_CORE="${CMAKE_CURRENT_SOURCE_DIR}/../core"
  OMAMAP_BUILD_DIR="${CMAKE_CURRENT_BINARY_DIR}"
)
target_link_libraries(omamap PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::WebEngineCore Qt6::WebEngineWidgets)

install(TARGETS omamap RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(DIRECTORY ../core/ DESTINATION ${CMAKE_INSTALL_DATADIR}/omamap/core)
install(FILES ../packaging/omamap.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES ../packaging/omamap-mime.xml DESTINATION ${CMAKE_INSTALL_DATADIR}/mime/packages RENAME omamap.xml)
install(FILES ../packaging/omamap.svg DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps)
install(FILES ../LICENSE DESTINATION ${CMAKE_INSTALL_DATADIR}/licenses/omamap)
